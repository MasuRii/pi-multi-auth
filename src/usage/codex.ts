import { request as httpsRequest } from "node:https";
import { getErrorMessage, isRecord } from "../auth-error-utils.js";
import { quotaClassifier } from "../quota-classifier.js";
import { headersToRecord, rateLimitHeaderParser } from "../rate-limit-headers.js";
import type {
	RateLimitWindow,
	UsageAuth,
	UsageCredits,
	UsageProvider,
	UsageSnapshot,
} from "./types.js";

const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USAGE_USER_AGENT = "pi-multi-auth/0.1.0";
const CODEX_USAGE_REQUEST_TIMEOUT_MS = 3_000;
const OPENAI_AUTH_CLAIM_KEY = "https://api.openai.com/auth";
const MAX_CODEX_ACCOUNT_ID_CACHE_ENTRIES = 128;

interface CodexUsageResponse {
	plan_type: string | null;
	rate_limit: {
		allowed?: boolean;
		limit_reached?: boolean;
		primary_window: RateLimitWindow | null;
		secondary_window: RateLimitWindow | null;
	};
	credits: UsageCredits | null;
}

const PLAN_TYPE_MAP: Record<string, string> = {
	plus: "ChatGPT Plus",
	pro: "ChatGPT Pro",
	team: "ChatGPT Team",
	enterprise: "ChatGPT Enterprise",
};

const cachedCodexAccountIdsByToken = new Map<string, string | null>();


function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	const payloadPart = parts[1];
	if (!payloadPart) {
		return null;
	}

	const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
	const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;

	try {
		const decoded = Buffer.from(padded, "base64").toString("utf-8");
		const payload = JSON.parse(decoded) as unknown;
		return isRecord(payload) ? payload : null;
	} catch {
		return null;
	}
}

function cacheCodexAccountId(accessToken: string, accountId: string | null): string | null {
	cachedCodexAccountIdsByToken.set(accessToken, accountId);
	if (cachedCodexAccountIdsByToken.size > MAX_CODEX_ACCOUNT_ID_CACHE_ENTRIES) {
		const oldestToken = cachedCodexAccountIdsByToken.keys().next().value;
		if (typeof oldestToken === "string") {
			cachedCodexAccountIdsByToken.delete(oldestToken);
		}
	}
	return accountId;
}

function resolveCodexAccountIdFromToken(accessToken: string): string | null {
	if (cachedCodexAccountIdsByToken.has(accessToken)) {
		return cachedCodexAccountIdsByToken.get(accessToken) ?? null;
	}

	const payload = decodeJwtPayload(accessToken);
	if (!payload) {
		return cacheCodexAccountId(accessToken, null);
	}

	const authClaim = payload[OPENAI_AUTH_CLAIM_KEY];
	if (!isRecord(authClaim)) {
		return cacheCodexAccountId(accessToken, null);
	}

	return cacheCodexAccountId(accessToken, asNonEmptyString(authClaim.chatgpt_account_id));
}

function resolveCodexAccountId(auth: UsageAuth): string | null {
	const explicitAccountId =
		asNonEmptyString(auth.accountId) ?? asNonEmptyString(auth.credential?.accountId);
	if (explicitAccountId) {
		return explicitAccountId;
	}

	return resolveCodexAccountIdFromToken(auth.accessToken);
}

function normalizeUsedPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function parseRateLimitWindow(value: unknown): RateLimitWindow | null {
	if (!isRecord(value)) {
		return null;
	}

	const usedPercent = asNumber(value.used_percent);
	if (usedPercent === null) {
		return null;
	}

	const limitWindowSeconds = asNumber(value.limit_window_seconds);
	const resetAt = asNumber(value.reset_at);

	return {
		usedPercent: normalizeUsedPercent(usedPercent),
		windowMinutes: limitWindowSeconds === null ? null : Math.round(limitWindowSeconds / 60),
		resetsAt: resetAt,
	};
}

function parseCredits(value: unknown): UsageCredits | null {
	if (!isRecord(value)) {
		return null;
	}

	if (typeof value.has_credits !== "boolean" || typeof value.unlimited !== "boolean") {
		return null;
	}

	return {
		hasCredits: value.has_credits,
		unlimited: value.unlimited,
		balance: asStringOrNull(value.balance),
	};
}

function parseUsageResponse(data: unknown): CodexUsageResponse | null {
	if (!isRecord(data)) {
		return null;
	}

	const rateLimit = isRecord(data.rate_limit) ? data.rate_limit : null;
	if (!rateLimit) {
		return null;
	}

	return {
		plan_type: asStringOrNull(data.plan_type),
		rate_limit: {
			allowed: typeof rateLimit.allowed === "boolean" ? rateLimit.allowed : undefined,
			limit_reached:
				typeof rateLimit.limit_reached === "boolean" ? rateLimit.limit_reached : undefined,
			primary_window: parseRateLimitWindow(rateLimit.primary_window),
			secondary_window: parseRateLimitWindow(rateLimit.secondary_window),
		},
		credits: parseCredits(data.credits),
	};
}

function formatPlanType(planType: string | null): string | null {
	if (!planType) {
		return null;
	}
	const normalized = planType.trim().toLowerCase();
	if (!normalized) {
		return null;
	}
	return PLAN_TYPE_MAP[normalized] ?? planType;
}

function isCodexUsageTransportError(error: unknown): boolean {
	const message = getErrorMessage(error);
	return /fetch failed|econnreset|ehostunreach|enetunreach|etimedout|connection reset by peer|socket hang up|network/i.test(
		message,
	);
}

function createCodexUsageTimeoutError(timeoutMs: number, viaIpv4Fallback: boolean = false): Error {
	return new Error(
		`OpenAI Codex usage request timed out after ${timeoutMs}ms${viaIpv4Fallback ? " during IPv4 fallback" : ""}`,
	);
}

async function fetchCodexUsageViaIpv4(
	headers: Record<string, string>,
	timeoutMs: number = CODEX_USAGE_REQUEST_TIMEOUT_MS,
): Promise<{ status: number; bodyText: string; responseHeaders: Record<string, string> }> {
	const url = new URL(CODEX_USAGE_ENDPOINT);

	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (fn: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			fn();
		};
		const request = httpsRequest(
			url,
			{
				method: "GET",
				headers,
				family: 4,
			},
			(response) => {
				let bodyText = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					bodyText += chunk;
				});
				response.on("end", () => {
					settle(() => resolve({
						status: response.statusCode ?? 0,
						bodyText,
						responseHeaders: Object.fromEntries(
							Object.entries(response.headers)
								.filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
								.map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]),
						),
					}));
				});
			},
		);

		request.setTimeout(timeoutMs, () => {
			settle(() => {
				request.destroy();
				reject(createCodexUsageTimeoutError(timeoutMs, true));
			});
		});
		request.on("error", (error) => {
			settle(() => reject(error));
		});
		request.end();
	});
}

async function fetchCodexUsageResponse(
	headers: Record<string, string>,
	timeoutMs: number = CODEX_USAGE_REQUEST_TIMEOUT_MS,
): Promise<{
	status: number;
	bodyText: string;
	viaIpv4Fallback: boolean;
	responseHeaders: Record<string, string>;
}> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(CODEX_USAGE_ENDPOINT, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		return {
			status: response.status,
			bodyText: await response.text(),
			viaIpv4Fallback: false,
			responseHeaders: headersToRecord(response.headers),
		};
	} catch (error: unknown) {
		if (error instanceof Error && error.name === "AbortError") {
			throw createCodexUsageTimeoutError(timeoutMs);
		}
		if (!isCodexUsageTransportError(error)) {
			throw error;
		}

		const fallback = await fetchCodexUsageViaIpv4(headers, timeoutMs);
		return {
			...fallback,
			viaIpv4Fallback: true,
		};
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Fetches OpenAI Codex usage/quota from /backend-api/wham/usage.
 */
export const codexUsageProvider: UsageProvider<UsageAuth> = {
	id: "openai-codex",
	displayName: "OpenAI Codex",
	fetchUsage: async (auth: UsageAuth): Promise<UsageSnapshot | null> => {
		if (!auth.accessToken) {
			return null;
		}

		const headers: Record<string, string> = {
			Authorization: `Bearer ${auth.accessToken}`,
			"User-Agent": CODEX_USAGE_USER_AGENT,
		};

		const accountId = resolveCodexAccountId(auth);
		if (accountId) {
			headers["ChatGPT-Account-Id"] = accountId;
		}

		const response = await fetchCodexUsageResponse(headers);
		if (response.status === 401) {
			throw new Error("OpenAI Codex token expired or invalid");
		}
		if (response.status === 403) {
			throw new Error("OpenAI Codex usage access was denied for this account");
		}
		if (response.status < 200 || response.status >= 300) {
			throw new Error(
				`OpenAI usage request failed with status ${response.status}${response.viaIpv4Fallback ? " (after IPv4 fallback)" : ""}`,
			);
		}

		let data: unknown;
		try {
			data = JSON.parse(response.bodyText) as unknown;
		} catch (error: unknown) {
			throw new Error(
				`OpenAI usage response was not valid JSON${response.viaIpv4Fallback ? " after IPv4 fallback" : ""}: ${getErrorMessage(error)}`,
			);
		}
		const parsed = parseUsageResponse(data);
		if (!parsed) {
			throw new Error("OpenAI usage response format was invalid");
		}

		const rateLimitHeaders = rateLimitHeaderParser.parseHeaders(
			response.responseHeaders,
			"openai-codex",
		);
		const quotaClassification = quotaClassifier.classifyFromUsage(
			parsed.rate_limit.primary_window,
			parsed.rate_limit.secondary_window,
			rateLimitHeaders,
		).classification;
		const now = Date.now();
		return {
			timestamp: now,
			provider: "openai-codex",
			planType: formatPlanType(parsed.plan_type),
			primary: parsed.rate_limit.primary_window,
			secondary: parsed.rate_limit.secondary_window,
			credits: parsed.credits,
			copilotQuota: null,
			updatedAt: now,
			rateLimitHeaders,
			estimatedResetAt: rateLimitHeaderParser.getEstimatedResetAt(rateLimitHeaders) ?? undefined,
			quotaClassification,
		};
	},
};
