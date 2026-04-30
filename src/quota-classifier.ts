import type { RateLimitWindow } from "./usage/types.js";
import {
	QUOTA_COOLDOWN_MS,
	QUOTA_RECOVERY_ACTIONS,
	type ParsedRateLimitHeaders,
	type QuotaClassification,
	type QuotaClassificationResult,
	type QuotaStateForCredential,
	type QuotaWindow,
	type RecoveryAction,
} from "./types-quota.js";

const MESSAGE_PATTERNS: Record<QuotaClassification, RegExp[]> = {
	hourly: [
		/rate.?limit/i,
		/requests?.per.?hour/i,
		/hourly.?limit/i,
		/try.?again.?in?.*minute/i,
	],
	daily: [
		/daily.?limit/i,
		/daily.?free.?allocation/i,
		/used.?up.?your.?daily/i,
		/neurons?.*per.?day/i,
		/per.?day/i,
		/24.?hour/i,
		/try.?again.?tomorrow/i,
		/reset.?at.?midnight/i,
	],
	weekly: [
		/weekly.?limit/i,
		/per.?week/i,
		/7.?day/i,
		/try.?again.?next.?week/i,
	],
	monthly: [
		/monthly.?limit/i,
		/per.?month/i,
		/30.?day/i,
		/billing.?cycle/i,
		/reset.?next.?month/i,
	],
	balance: [
		/outstanding.?balance/i,
		/insufficient.?balance/i,
		/no.?credits?/i,
		/credits?.depleted/i,
		/add.?funds/i,
		/payment.?required/i,
	],
	organization: [
		/organization.?disabled/i,
		/organization.?restricted/i,
		/account.?suspended/i,
		/enterprise.?limit/i,
	],
	unknown: [],
};

const CLOUDFLARE_DAILY_RESET_PATTERNS: RegExp[] = [
	/daily.?free.?allocation/i,
	/used.?up.?your.?daily/i,
	/\b10,?000\s+neurons\b/i,
	/cloudflare(?:'s)?\s+workers\s+paid\s+plan/i,
];

function matchesAny(message: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(message));
}

function getNextUtcMidnightMs(now: number = Date.now()): number {
	const date = new Date(now);
	return Date.UTC(
		date.getUTCFullYear(),
		date.getUTCMonth(),
		date.getUTCDate() + 1,
		0,
		0,
		0,
		0,
	);
}

function buildQuotaWindow(
	classification: QuotaClassification,
	windowEndMs: number,
	now: number = Date.now(),
): QuotaWindow {
	const safeWindowEndMs = Math.max(windowEndMs, now);
	const resetInMs = Math.max(0, safeWindowEndMs - now);
	return {
		classification,
		windowStartMs: now,
		windowEndMs: safeWindowEndMs,
		resetInMs,
		resetAtFormatted: new Date(safeWindowEndMs).toISOString(),
	};
}

function classifyDuration(msUntilReset: number): QuotaClassification {
	if (!Number.isFinite(msUntilReset) || msUntilReset <= 0) {
		return "unknown";
	}
	if (msUntilReset <= 2 * 60 * 60 * 1000) {
		return "hourly";
	}
	if (msUntilReset <= 36 * 60 * 60 * 1000) {
		return "daily";
	}
	if (msUntilReset <= 8 * 24 * 60 * 60 * 1000) {
		return "weekly";
	}
	if (msUntilReset <= 45 * 24 * 60 * 60 * 1000) {
		return "monthly";
	}
	return "unknown";
}

function cooldownFor(classification: QuotaClassification): number {
	return QUOTA_COOLDOWN_MS[classification] ?? QUOTA_COOLDOWN_MS.unknown;
}

function recoveryActionFor(classification: QuotaClassification): RecoveryAction {
	return { ...QUOTA_RECOVERY_ACTIONS[classification] };
}

function recoveryActionWithEstimatedWait(
	classification: QuotaClassification,
	estimatedWaitMs: number | undefined,
): RecoveryAction {
	const action = recoveryActionFor(classification);
	if (typeof estimatedWaitMs === "number" && Number.isFinite(estimatedWaitMs)) {
		return { ...action, estimatedWaitMs };
	}
	return action;
}

function inferMessageQuotaWindow(
	classification: QuotaClassification,
	message: string,
	now: number = Date.now(),
): QuotaWindow | undefined {
	if (classification === "daily" && matchesAny(message, CLOUDFLARE_DAILY_RESET_PATTERNS)) {
		return buildQuotaWindow(classification, getNextUtcMidnightMs(now), now);
	}
	return undefined;
}

function inferClassificationFromWindow(window: RateLimitWindow | null): QuotaClassification {
	if (!window || window.usedPercent < 100) {
		return "unknown";
	}

	if (typeof window.windowMinutes === "number" && Number.isFinite(window.windowMinutes)) {
		if (window.windowMinutes <= 120) {
			return "hourly";
		}
		if (window.windowMinutes <= 36 * 60) {
			return "daily";
		}
		if (window.windowMinutes <= 8 * 24 * 60) {
			return "weekly";
		}
		if (window.windowMinutes <= 45 * 24 * 60) {
			return "monthly";
		}
	}

	if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
		return classifyDuration(window.resetsAt - Date.now());
	}

	return "unknown";
}

export class QuotaClassifier {
	classifyFromHeaders(headers: ParsedRateLimitHeaders): QuotaClassificationResult {
		const resetAt = headers.resetAt;
		const remaining = headers.remaining;
		const now = Date.now();
		const classification =
			typeof resetAt === "number" && Number.isFinite(resetAt)
				? classifyDuration(resetAt - now)
				: "unknown";
		const confidence = headers.confidence === "high" ? "high" : "medium";
		const window =
			classification !== "unknown" && typeof resetAt === "number" && Number.isFinite(resetAt)
				? buildQuotaWindow(classification, resetAt, now)
				: undefined;

		return {
			classification:
				remaining !== null && remaining > 0 && classification === "unknown"
					? "unknown"
					: classification,
			window,
			cooldownMs: cooldownFor(classification),
			recoveryAction: recoveryActionFor(classification),
			confidence,
			source: "header",
		};
	}

	classifyFromMessage(
		errorMessage: string,
		headers?: ParsedRateLimitHeaders,
	): QuotaClassificationResult {
		const normalizedMessage = errorMessage.trim();
		if (headers) {
			const headerResult = this.classifyFromHeaders(headers);
			if (headerResult.confidence === "high" && headerResult.classification !== "unknown") {
				return headerResult;
			}
		}

		for (const classification of [
			"balance",
			"organization",
			"monthly",
			"weekly",
			"daily",
			"hourly",
		] as const) {
			if (matchesAny(normalizedMessage, MESSAGE_PATTERNS[classification])) {
				const now = Date.now();
				const window = inferMessageQuotaWindow(classification, normalizedMessage, now);
				const cooldownMs = window?.resetInMs ?? cooldownFor(classification);
				return {
					classification,
					window,
					cooldownMs,
					recoveryAction: recoveryActionWithEstimatedWait(
						classification,
						window?.resetInMs,
					),
					confidence: classification === "hourly" ? "medium" : "high",
					source: "message",
				};
			}
		}

		return {
			classification: "unknown",
			cooldownMs: cooldownFor("unknown"),
			recoveryAction: recoveryActionFor("unknown"),
			confidence: "low",
			source: "default",
		};
	}

	classifyFromUsage(
		primary: RateLimitWindow | null,
		secondary: RateLimitWindow | null,
		headers?: ParsedRateLimitHeaders,
	): QuotaClassificationResult {
		const headerResult = headers ? this.classifyFromHeaders(headers) : null;
		if (headerResult && headerResult.classification !== "unknown") {
			return headerResult;
		}

		const candidates = [secondary, primary]
			.map((window) => inferClassificationFromWindow(window))
			.filter((classification): classification is Exclude<QuotaClassification, "unknown"> =>
				classification !== "unknown",
			);
		const hasClassification = candidates.length > 0;
		const classification: QuotaClassification = hasClassification ? candidates[0] : "unknown";
		const resetAt = secondary?.resetsAt ?? primary?.resetsAt ?? null;
		return {
			classification,
			window:
				hasClassification && typeof resetAt === "number" && Number.isFinite(resetAt)
					? buildQuotaWindow(classification, resetAt)
					: undefined,
			cooldownMs: cooldownFor(classification),
			recoveryAction: recoveryActionFor(classification),
			confidence: hasClassification ? "medium" : "low",
			source: hasClassification ? "message" : "default",
		};
	}

	getRecoveryAction(classification: QuotaClassification): RecoveryAction {
		return recoveryActionFor(classification);
	}

	requiresManualIntervention(classification: QuotaClassification): boolean {
		return recoveryActionFor(classification).requiresManual;
	}

	shouldDisableCredential(classification: QuotaClassification): boolean {
		return classification === "balance" || classification === "organization";
	}

	createQuotaState(
		credentialId: string,
		errorMessage: string,
		result: QuotaClassificationResult,
		detectedAt: number = Date.now(),
	): QuotaStateForCredential {
		return {
			credentialId,
			classification: result.classification,
			detectedAt,
			resetAt: result.window?.windowEndMs,
			errorMessage: errorMessage.trim() || "Quota state recorded",
			recoveryAction: result.recoveryAction,
		};
	}
}

export const quotaClassifier = new QuotaClassifier();
