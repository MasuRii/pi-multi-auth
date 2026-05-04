import { fetchWithTimeout } from "../async-utils.js";
import { isRecord } from "../auth-error-utils.js";

import type {
	CopilotQuota,
	CopilotQuotaBucket,
	UsageAuth,
	UsageProvider,
	UsageSnapshot,
} from "./types.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const COPILOT_INTERNAL_USER_URL = `${GITHUB_API_BASE_URL}/copilot_internal/user`;
const COPILOT_TOKEN_EXCHANGE_URL = `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`;

const COPILOT_VERSION = "0.35.0";
const COPILOT_HEADERS: Record<string, string> = {
	"User-Agent": `GitHubCopilotChat/${COPILOT_VERSION}`,
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": `copilot-chat/${COPILOT_VERSION}`,
	"Copilot-Integration-Id": "vscode-chat",
};

const REQUEST_TIMEOUT_MS = 3_000;

interface CopilotInternalUserResponse {
	access_type_sku?: string;
	copilot_plan?: string;
	limited_user_quotas?: {
		chat?: number;
		completions?: number;
	};
	limited_user_reset_date?: string;
	quota_reset_date?: string;
	quota_snapshots?: {
		premium_interactions?: {
			entitlement?: number;
			percent_remaining?: number;
			remaining?: number;
			unlimited?: boolean;
		};
	};
	monthly_quotas?: {
		chat?: number;
		completions?: number;
	};
}


function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function parseResetAt(value: string | null): number | null {
	if (!value) {
		return null;
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeChatQuota(remaining: number, total: number): { remaining: number; total: number } {
	const scale = total === 500 ? 10 : 1;
	return {
		remaining: Math.floor(remaining / scale),
		total: Math.floor(total / scale),
	};
}

function normalizeCompletionsQuota(remaining: number, total: number): { remaining: number; total: number } {
	const scale = total === 4000 ? 2 : 1;
	return {
		remaining: Math.floor(remaining / scale),
		total: Math.floor(total / scale),
	};
}

function createQuotaBucket(
	remaining: number | null,
	total: number | null,
	options?: { unlimited?: boolean; percentUsedOverride?: number | null },
): CopilotQuotaBucket {
	const unlimited = options?.unlimited === true;
	if (unlimited) {
		return {
			used: null,
			total: null,
			remaining: remaining === null ? null : Math.max(0, Math.floor(remaining)),
			percentUsed: null,
			unlimited: true,
		};
	}

	if (remaining === null || total === null || total <= 0) {
		return {
			used: null,
			total: total !== null && total > 0 ? Math.floor(total) : null,
			remaining: remaining === null ? null : Math.max(0, Math.floor(remaining)),
			percentUsed: options?.percentUsedOverride === null ? null : options?.percentUsedOverride ?? null,
			unlimited: false,
		};
	}

	const normalizedTotal = Math.max(1, Math.floor(total));
	const normalizedRemaining = Math.max(0, Math.min(normalizedTotal, Math.floor(remaining)));
	const used = normalizedTotal - normalizedRemaining;
	const percentUsedFromCounts = clampPercent((used / normalizedTotal) * 100);
	const percentUsed =
		typeof options?.percentUsedOverride === "number"
			? clampPercent(options.percentUsedOverride)
			: percentUsedFromCounts;

	return {
		used,
		total: normalizedTotal,
		remaining: normalizedRemaining,
		percentUsed,
		unlimited: false,
	};
}

function parseFromLimitedQuotas(data: CopilotInternalUserResponse): CopilotQuota | null {
	const limited = isRecord(data.limited_user_quotas) ? data.limited_user_quotas : null;
	if (!limited) {
		return null;
	}

	const chatRemainingRaw = asNumber(limited.chat);
	if (chatRemainingRaw === null) {
		return null;
	}

	const monthly = isRecord(data.monthly_quotas) ? data.monthly_quotas : null;
	const chatTotalRaw = asNumber(monthly?.chat);

	const normalizedChat =
		chatTotalRaw === null
			? { remaining: Math.max(0, Math.floor(chatRemainingRaw)), total: null }
			: normalizeChatQuota(chatRemainingRaw, chatTotalRaw);

	const chat = createQuotaBucket(normalizedChat.remaining, normalizedChat.total);

	const completionsRemainingRaw = asNumber(limited.completions);
	const completionsTotalRaw = asNumber(monthly?.completions);

	let completions: CopilotQuotaBucket | null = null;
	if (completionsRemainingRaw !== null || completionsTotalRaw !== null) {
		if (completionsRemainingRaw !== null && completionsTotalRaw !== null) {
			const normalizedCompletions = normalizeCompletionsQuota(
				completionsRemainingRaw,
				completionsTotalRaw,
			);
			completions = createQuotaBucket(normalizedCompletions.remaining, normalizedCompletions.total);
		} else {
			completions = createQuotaBucket(completionsRemainingRaw, completionsTotalRaw);
		}
	}

	const resetAt = parseResetAt(asString(data.limited_user_reset_date) ?? asString(data.quota_reset_date));

	return {
		chat,
		completions,
		resetAt,
	};
}

function parseFromPremiumSnapshots(data: CopilotInternalUserResponse): CopilotQuota | null {
	const snapshots = isRecord(data.quota_snapshots) ? data.quota_snapshots : null;
	const premium = isRecord(snapshots?.premium_interactions) ? snapshots.premium_interactions : null;
	if (!premium) {
		return null;
	}

	const unlimited = premium.unlimited === true;
	const remainingRaw = asNumber(premium.remaining);
	const entitlementRaw = asNumber(premium.entitlement);
	const percentRemaining = asNumber(premium.percent_remaining);
	const percentUsedOverride =
		percentRemaining === null ? null : clampPercent(100 - percentRemaining);

	let chat: CopilotQuotaBucket;
	if (unlimited) {
		chat = createQuotaBucket(remainingRaw, null, { unlimited: true });
	} else {
		if (remainingRaw === null || entitlementRaw === null) {
			return null;
		}

		const normalizedChat = normalizeChatQuota(remainingRaw, entitlementRaw);
		chat = createQuotaBucket(normalizedChat.remaining, normalizedChat.total, {
			percentUsedOverride,
		});
	}

	const resetAt = parseResetAt(asString(data.quota_reset_date) ?? asString(data.limited_user_reset_date));

	return {
		chat,
		completions: null,
		resetAt,
	};
}

function parseCopilotQuota(data: unknown): CopilotQuota | null {
	if (!isRecord(data)) {
		return null;
	}

	const response = data as CopilotInternalUserResponse;
	return parseFromLimitedQuotas(response) ?? parseFromPremiumSnapshots(response);
}

function parseCopilotPlanType(data: unknown, quota: CopilotQuota): string | null {
	if (isRecord(data)) {
		const plan = asString(data.copilot_plan);
		if (plan) {
			return plan;
		}
		const sku = asString(data.access_type_sku);
		if (sku) {
			return sku;
		}
	}

	if (quota.chat.unlimited) {
		return "Copilot Unlimited";
	}

	return null;
}

function uniqueNonEmptyStrings(values: ReadonlyArray<string | null | undefined>): string[] {
	const seen = new Set<string>();
	const tokens: string[] = [];

	for (const value of values) {
		if (!value) {
			continue;
		}

		const normalized = value.trim();
		if (!normalized || seen.has(normalized)) {
			continue;
		}

		seen.add(normalized);
		tokens.push(normalized);
	}

	return tokens;
}

function getCopilotTokenCandidates(auth: UsageAuth): string[] {
	const credential = isRecord(auth.credential) ? auth.credential : null;
	const refreshToken = asString(credential?.refresh);
	const credentialAccessToken = asString(credential?.access);
	return uniqueNonEmptyStrings([refreshToken, auth.accessToken, credentialAccessToken]);
}

async function exchangeForCopilotToken(oauthToken: string): Promise<string | null> {
	const response = await fetchWithTimeout(
		COPILOT_TOKEN_EXCHANGE_URL,
		{
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${oauthToken}`,
				...COPILOT_HEADERS,
			},
		},
		{
			timeoutMs: REQUEST_TIMEOUT_MS,
			timeoutMessage: `GitHub Copilot usage request timed out after ${REQUEST_TIMEOUT_MS}ms`,
		},
	);

	if (!response.ok) {
		return null;
	}

	const payload = (await response.json()) as unknown;
	if (!isRecord(payload)) {
		return null;
	}

	const token = asString(payload.token);
	return token;
}

async function fetchInternalUser(authorization: string): Promise<Response> {
	return fetchWithTimeout(
		COPILOT_INTERNAL_USER_URL,
		{
			headers: {
				Accept: "application/json",
				Authorization: authorization,
				...COPILOT_HEADERS,
			},
		},
		{
			timeoutMs: REQUEST_TIMEOUT_MS,
			timeoutMessage: `GitHub Copilot usage request timed out after ${REQUEST_TIMEOUT_MS}ms`,
		},
	);
}

/**
 * Fetches GitHub Copilot quota details from the internal /copilot_internal/user endpoint.
 */
export const copilotUsageProvider: UsageProvider<UsageAuth> = {
	id: "github-copilot",
	displayName: "GitHub Copilot",
	fetchUsage: async (auth: UsageAuth): Promise<UsageSnapshot | null> => {
		const tokenCandidates = getCopilotTokenCandidates(auth);
		if (tokenCandidates.length === 0) {
			return null;
		}

		const attemptedStatuses: number[] = [];
		let response: Response | null = null;

		for (const token of tokenCandidates) {
			const directResponse = await fetchInternalUser(`token ${token}`);
			if (directResponse.ok) {
				response = directResponse;
				break;
			}
			attemptedStatuses.push(directResponse.status);
		}

		if (!response) {
			for (const token of tokenCandidates) {
				const copilotToken = await exchangeForCopilotToken(token);
				if (!copilotToken) {
					continue;
				}

				const exchangedResponse = await fetchInternalUser(`Bearer ${copilotToken}`);
				if (exchangedResponse.ok) {
					response = exchangedResponse;
					break;
				}
				attemptedStatuses.push(exchangedResponse.status);
			}
		}

		if (!response) {
			const statusSuffix =
				attemptedStatuses.length > 0
					? ` (statuses: ${attemptedStatuses.join(", ")})`
					: "";
			throw new Error(`GitHub Copilot usage request failed${statusSuffix}`);
		}

		const payload = (await response.json()) as unknown;
		const copilotQuota = parseCopilotQuota(payload);
		if (!copilotQuota) {
			throw new Error("GitHub Copilot usage response format was invalid");
		}

		const now = Date.now();
		return {
			timestamp: now,
			provider: "github-copilot",
			planType: parseCopilotPlanType(payload, copilotQuota),
			primary: null,
			secondary: null,
			credits: null,
			copilotQuota,
			updatedAt: now,
		};
	},
};
