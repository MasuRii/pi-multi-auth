import type { ParsedRateLimitHeaders, ProviderRateLimitConfig } from "./types-quota.js";

const GOOGLE_CONFIG: ProviderRateLimitConfig = {
	limitHeaders: ["x-ratelimit-limit"],
	remainingHeaders: ["x-ratelimit-remaining"],
	resetHeaders: [],
	resetFormat: "epoch",
	parseRetryAfter: true,
};

const PROVIDER_CONFIGS: Record<string, ProviderRateLimitConfig> = {
	"openai-codex": {
		limitHeaders: ["x-ratelimit-limit-requests", "x-ratelimit-limit"],
		remainingHeaders: ["x-ratelimit-remaining-requests", "x-ratelimit-remaining"],
		resetHeaders: ["x-ratelimit-reset-requests", "x-ratelimit-reset"],
		resetFormat: "seconds",
		parseRetryAfter: true,
	},
	"github-copilot": {
		limitHeaders: ["x-ratelimit-limit"],
		remainingHeaders: ["x-ratelimit-remaining"],
		resetHeaders: ["x-ratelimit-reset"],
		resetFormat: "epoch",
		parseRetryAfter: true,
	},
	anthropic: {
		limitHeaders: ["anthropic-ratelimit-requests-limit", "x-ratelimit-limit"],
		remainingHeaders: ["anthropic-ratelimit-requests-remaining", "x-ratelimit-remaining"],
		resetHeaders: ["anthropic-ratelimit-requests-reset"],
		resetFormat: "rfc3339",
		parseRetryAfter: true,
	},
	"google-gemini-cli": GOOGLE_CONFIG,
	"google-antigravity": GOOGLE_CONFIG,
};

const DEFAULT_CONFIG: ProviderRateLimitConfig = {
	limitHeaders: ["x-ratelimit-limit"],
	remainingHeaders: ["x-ratelimit-remaining"],
	resetHeaders: ["x-ratelimit-reset"],
	resetFormat: "seconds",
	parseRetryAfter: true,
};

export function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key] = value;
	});
	return record;
}

function normalizeHeaders(
	headers: Record<string, string | undefined>,
): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") {
			normalized[key.toLowerCase()] = value;
		}
	}
	return normalized;
}

export class RateLimitHeaderParser {
	parseHeaders(
		headers: Record<string, string | undefined>,
		providerId?: string,
	): ParsedRateLimitHeaders {
		const normalizedHeaders = normalizeHeaders(headers);
		const config = this.getConfig(providerId);
		const limit = this.parseNumericHeader(normalizedHeaders, config.limitHeaders);
		const remaining = this.parseNumericHeader(normalizedHeaders, config.remainingHeaders);
		const resetAt = this.parseResetHeader(normalizedHeaders, config);
		const retryAfterSeconds = config.parseRetryAfter === false
			? null
			: this.parseRetryAfter(normalizedHeaders);
		const estimatedResetAt = this.getEstimatedResetAtFromParts(resetAt, retryAfterSeconds);
		const resolvedResetAt = resetAt ?? estimatedResetAt;
		const { confidence, source } = this.determineConfidence(resetAt, retryAfterSeconds, config);

		return {
			limit,
			remaining,
			resetAt: resolvedResetAt,
			retryAfterSeconds,
			resetAtFormatted: resolvedResetAt !== null ? new Date(resolvedResetAt).toISOString() : null,
			confidence,
			source,
		};
	}

	hasRemainingRequests(parsed: ParsedRateLimitHeaders): boolean | null {
		if (parsed.remaining === null) {
			return null;
		}
		return parsed.remaining > 0;
	}

	getEstimatedCooldown(parsed: ParsedRateLimitHeaders, fallbackMs: number = 60_000): number {
		if (parsed.resetAt !== null) {
			return Math.max(0, parsed.resetAt - Date.now());
		}
		if (parsed.retryAfterSeconds !== null) {
			return parsed.retryAfterSeconds * 1000;
		}
		return fallbackMs;
	}

	getEstimatedResetAt(parsed: ParsedRateLimitHeaders): number | null {
		return parsed.resetAt ?? this.getEstimatedResetAtFromParts(null, parsed.retryAfterSeconds);
	}

	private getConfig(providerId?: string): ProviderRateLimitConfig {
		if (!providerId) {
			return DEFAULT_CONFIG;
		}
		return PROVIDER_CONFIGS[providerId] ?? DEFAULT_CONFIG;
	}

	private parseNumericHeader(headers: Record<string, string>, names: readonly string[]): number | null {
		for (const name of names) {
			const rawValue = headers[name.toLowerCase()];
			if (!rawValue) {
				continue;
			}
			const parsed = Number.parseInt(rawValue, 10);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
		return null;
	}

	private parseResetHeader(
		headers: Record<string, string>,
		config: ProviderRateLimitConfig,
	): number | null {
		for (const name of config.resetHeaders) {
			const rawValue = headers[name.toLowerCase()];
			if (!rawValue) {
				continue;
			}
			const parsed = this.parseResetValue(rawValue, config.resetFormat);
			if (parsed !== null) {
				return parsed;
			}
		}
		return null;
	}

	private parseResetValue(
		value: string,
		format: ProviderRateLimitConfig["resetFormat"],
	): number | null {
		switch (format) {
			case "epoch": {
				const parsed = Number.parseInt(value, 10);
				if (!Number.isFinite(parsed)) {
					return null;
				}
				return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
			}
			case "rfc3339": {
				const timestamp = Date.parse(value);
				return Number.isFinite(timestamp) ? timestamp : null;
			}
			case "seconds": {
				const seconds = Number.parseFloat(value);
				if (!Number.isFinite(seconds)) {
					return null;
				}
				return Date.now() + seconds * 1000;
			}
		}
	}

	private parseRetryAfter(headers: Record<string, string>): number | null {
		const rawValue = headers["retry-after"];
		if (!rawValue) {
			return null;
		}

		const seconds = Number.parseInt(rawValue, 10);
		if (Number.isFinite(seconds)) {
			return Math.max(0, seconds);
		}

		const retryAt = Date.parse(rawValue);
		if (!Number.isFinite(retryAt)) {
			return null;
		}

		return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
	}

	private determineConfidence(
		resetAt: number | null,
		retryAfterSeconds: number | null,
		config: ProviderRateLimitConfig,
	): { confidence: ParsedRateLimitHeaders["confidence"]; source: ParsedRateLimitHeaders["source"] } {
		if (resetAt !== null) {
			return { confidence: "high", source: "x-ratelimit-reset" };
		}
		if (retryAfterSeconds !== null) {
			return { confidence: "medium", source: "retry-after" };
		}
		if (config.resetHeaders.length === 0) {
			return { confidence: "low", source: "unknown" };
		}
		return { confidence: "low", source: "unknown" };
	}

	private getEstimatedResetAtFromParts(
		resetAt: number | null,
		retryAfterSeconds: number | null,
	): number | null {
		if (resetAt !== null) {
			return resetAt;
		}
		if (retryAfterSeconds === null) {
			return null;
		}
		return Date.now() + retryAfterSeconds * 1000;
	}
}

export const rateLimitHeaderParser = new RateLimitHeaderParser();
