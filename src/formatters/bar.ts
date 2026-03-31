import type { CopilotQuotaBucket } from "../usage/types.js";

/**
 * Renders a 15-character quota progress bar.
 */
export function formatBar(pct: number): string {
	const clamped = Math.max(0, Math.min(100, pct));
	const size = 15;
	const filled = Math.round((clamped / 100) * size);
	return `${"█".repeat(filled)}${"░".repeat(size - filled)}`;
}

/**
 * Returns a human-readable usage label with progress bar and percentages.
 */
export function formatUsageBar(usedPercent: number): string {
	const clamped = Math.max(0, Math.min(100, usedPercent));
	const roundedUsed = Math.round(clamped);
	const roundedLeft = Math.max(0, 100 - roundedUsed);
	return `${formatBar(clamped)} ${roundedUsed}% used (${roundedLeft}% left)`;
}

/**
 * Formats one Copilot quota bucket with bar + used/total data.
 */
export function formatCopilotQuota(label: string, quota: CopilotQuotaBucket): string {
	if (quota.unlimited) {
		return `${label}: ${formatBar(100)} Unlimited (∞)`;
	}

	if (
		typeof quota.percentUsed !== "number" ||
		typeof quota.used !== "number" ||
		typeof quota.total !== "number" ||
		quota.total <= 0
	) {
		return `${label}: n/a`;
	}

	return `${label}: ${formatUsageBar(quota.percentUsed)} | ${quota.used}/${quota.total} used`;
}

/**
 * Formats reset time as a relative countdown.
 */
export function formatResetCountdown(resetAt: number | null): string {
	if (!resetAt) {
		return "n/a";
	}

	const resetMs = resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1000;
	const deltaMs = resetMs - Date.now();
	if (deltaMs <= 0) {
		return "now";
	}

	const minutes = Math.max(1, Math.round(deltaMs / 60_000));
	if (minutes < 60) {
		return `${minutes}m`;
	}

	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}

	const days = Math.round(hours / 24);
	return `${days}d`;
}
