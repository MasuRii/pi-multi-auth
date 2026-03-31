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
