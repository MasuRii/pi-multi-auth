/**
 * Shared credential cooldown helpers used by credential rotation flows.
 */

/**
 * Weekly quota cooldown durations for exponential backoff.
 * Pattern: 12h -> 24h -> 48h -> 72h (max)
 */
export const WEEKLY_QUOTA_COOLDOWN_MS = Object.freeze([
	12 * 60 * 60 * 1000,
	24 * 60 * 60 * 1000,
	48 * 60 * 60 * 1000,
	72 * 60 * 60 * 1000,
] as const);

export const TRANSIENT_COOLDOWN_BASE_MS = 15_000;
export const TRANSIENT_COOLDOWN_MAX_MS = 15 * 60 * 1000;

const RETRY_AFTER_MESSAGE_PATTERN =
	/(?:try\s+again|retry)\s+(?:in|after)\s+~?\s*(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|min|hours?|hrs?|hr|days?|d)\b/i;

function resolveRetryAfterUnitMs(unit: string): number | undefined {
	const normalizedUnit = unit.trim().toLowerCase();
	if (["millisecond", "milliseconds", "msec", "msecs", "ms"].includes(normalizedUnit)) {
		return 1;
	}
	if (["second", "seconds", "sec", "secs", "s"].includes(normalizedUnit)) {
		return 1_000;
	}
	if (["minute", "minutes", "min", "mins"].includes(normalizedUnit)) {
		return 60_000;
	}
	if (["hour", "hours", "hr", "hrs", "h"].includes(normalizedUnit)) {
		return 60 * 60_000;
	}
	if (["day", "days", "d"].includes(normalizedUnit)) {
		return 24 * 60 * 60_000;
	}
	return undefined;
}

export function parseRetryAfterCooldownMs(message: string): number | undefined {
	const normalizedMessage = message.trim();
	if (!normalizedMessage) {
		return undefined;
	}

	const match = RETRY_AFTER_MESSAGE_PATTERN.exec(normalizedMessage);
	if (!match) {
		return undefined;
	}

	const value = Number.parseFloat(match[1] || "");
	const unitMs = resolveRetryAfterUnitMs(match[2] || "");
	if (!Number.isFinite(value) || value <= 0 || unitMs === undefined) {
		return undefined;
	}

	const cooldownMs = Math.ceil(value * unitMs);
	return Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : undefined;
}

export function computeExponentialBackoffMs(
	baseMs: number,
	attempt: number,
	maxMs: number,
): number {
	const safeAttempt = Math.max(1, Math.trunc(attempt));
	const scaled = baseMs * Math.pow(2, safeAttempt - 1);
	return Math.min(maxMs, Math.max(baseMs, scaled));
}

export function getWeeklyQuotaCooldownMs(attempt: number): number {
	const safeAttempt = Math.max(1, Math.trunc(attempt));
	const cooldownIndex = Math.min(safeAttempt - 1, WEEKLY_QUOTA_COOLDOWN_MS.length - 1);
	return WEEKLY_QUOTA_COOLDOWN_MS[cooldownIndex];
}
