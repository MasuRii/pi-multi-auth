import { quotaClassifier } from "../quota-classifier.js";
import { headersToRecord, rateLimitHeaderParser } from "../rate-limit-headers.js";
import type { RateLimitWindow, UsageAuth, UsageProvider, UsageSnapshot } from "./types.js";

const ANTHROPIC_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_OAUTH_BETA_HEADER = "oauth-2025-04-20";

interface AnthropicUsageWindow {
	utilization?: number;
	resets_at?: string;
}

interface AnthropicUsageResponse {
	five_hour?: AnthropicUsageWindow;
	seven_day?: AnthropicUsageWindow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number | null {
	if (typeof value !== "string" || value.trim().length === 0) {
		return null;
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function parseUsagePercent(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}

	return Math.max(0, Math.min(100, Math.round(value)));
}

function parseUsageWindow(window: unknown, windowMinutes: number): RateLimitWindow | null {
	if (!isRecord(window)) {
		return null;
	}

	const usedPercent = parseUsagePercent(window.utilization);
	if (usedPercent === null) {
		return null;
	}

	return {
		usedPercent,
		windowMinutes,
		resetsAt: parseTimestamp(window.resets_at),
	};
}

function parseUsageResponse(value: unknown): AnthropicUsageResponse | null {
	if (!isRecord(value)) {
		return null;
	}

	return {
		five_hour: isRecord(value.five_hour) ? (value.five_hour as AnthropicUsageWindow) : undefined,
		seven_day: isRecord(value.seven_day)
			? (value.seven_day as AnthropicUsageWindow)
			: undefined,
	};
}

function getAnthropicPlanType(auth: UsageAuth): string | null {
	const subscriptionType = auth.credential?.subscriptionType;
	if (typeof subscriptionType !== "string" || subscriptionType.trim().length === 0) {
		return null;
	}

	const normalized = subscriptionType.trim().toLowerCase();
	if (normalized.includes("max")) {
		return "Max";
	}
	if (normalized.includes("pro")) {
		return "Pro";
	}
	if (normalized.includes("team")) {
		return "Team";
	}

	return subscriptionType;
}

/**
 * Fetches Anthropic subscription usage from the OAuth usage endpoint.
 */
export const anthropicUsageProvider: UsageProvider<UsageAuth> = {
	id: "anthropic",
	displayName: "Anthropic",
	fetchUsage: async (auth: UsageAuth): Promise<UsageSnapshot | null> => {
		if (!auth.accessToken) {
			return null;
		}

		const response = await fetch(ANTHROPIC_USAGE_ENDPOINT, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${auth.accessToken}`,
				"anthropic-beta": ANTHROPIC_OAUTH_BETA_HEADER,
				"User-Agent": "pi-multi-auth",
			},
		});

		if (!response.ok) {
			if (response.status === 401) {
				throw new Error("Anthropic OAuth token expired or invalid");
			}
			if (response.status === 403) {
				throw new Error("Anthropic token is missing required usage scope");
			}
			throw new Error(`Anthropic usage request failed with status ${response.status}`);
		}

		const data = (await response.json()) as unknown;
		const parsed = parseUsageResponse(data);
		if (!parsed) {
			throw new Error("Anthropic usage response format was invalid");
		}

		const rateLimitHeaders = rateLimitHeaderParser.parseHeaders(
			headersToRecord(response.headers),
			"anthropic",
		);
		const primary = parseUsageWindow(parsed.five_hour, 300);
		const secondary = parseUsageWindow(parsed.seven_day, 10_080);
		const quotaClassification = quotaClassifier.classifyFromUsage(
			primary,
			secondary,
			rateLimitHeaders,
		).classification;
		const now = Date.now();
		return {
			timestamp: now,
			provider: "anthropic",
			planType: getAnthropicPlanType(auth),
			primary,
			secondary,
			credits: null,
			copilotQuota: null,
			updatedAt: now,
			rateLimitHeaders,
			estimatedResetAt: rateLimitHeaderParser.getEstimatedResetAt(rateLimitHeaders) ?? undefined,
			quotaClassification,
		};
	},
};
