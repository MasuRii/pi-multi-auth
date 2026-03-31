export type QuotaClassification =
	| "hourly"
	| "daily"
	| "weekly"
	| "monthly"
	| "balance"
	| "organization"
	| "unknown";

export interface ParsedRateLimitHeaders {
	limit: number | null;
	remaining: number | null;
	resetAt: number | null;
	retryAfterSeconds: number | null;
	resetAtFormatted: string | null;
	confidence: "high" | "medium" | "low";
	source: "x-ratelimit-reset" | "retry-after" | "estimated" | "unknown";
}

export interface ProviderRateLimitConfig {
	limitHeaders: string[];
	remainingHeaders: string[];
	resetHeaders: string[];
	resetFormat: "epoch" | "rfc3339" | "seconds";
	parseRetryAfter?: boolean;
}

export interface QuotaWindow {
	classification: QuotaClassification;
	windowStartMs: number;
	windowEndMs: number;
	resetInMs: number;
	resetAtFormatted: string;
}

export interface RecoveryAction {
	action: "wait" | "pay" | "contact_support" | "switch_credential" | "switch_provider";
	requiresManual: boolean;
	estimatedWaitMs?: number;
	description: string;
}

export interface QuotaClassificationResult {
	classification: QuotaClassification;
	window?: QuotaWindow;
	cooldownMs: number;
	recoveryAction: RecoveryAction;
	confidence: "high" | "medium" | "low";
	source: "header" | "message" | "default";
}

export interface QuotaStateForCredential {
	credentialId: string;
	classification: QuotaClassification;
	detectedAt: number;
	resetAt?: number;
	errorMessage: string;
	recoveryAction: RecoveryAction;
}

export interface QuotaClassificationConfig {
	enabled: boolean;
	cooldownOverrides: Partial<Record<QuotaClassification, number>>;
	customPatterns: Partial<Record<QuotaClassification, string[]>>;
}

export const QUOTA_COOLDOWN_MS: Record<QuotaClassification, number> = {
	hourly: 60 * 60 * 1000,
	daily: 24 * 60 * 60 * 1000,
	weekly: 72 * 60 * 60 * 1000,
	monthly: 7 * 24 * 60 * 60 * 1000,
	balance: Number.POSITIVE_INFINITY,
	organization: Number.POSITIVE_INFINITY,
	unknown: 60 * 60 * 1000,
};

export const QUOTA_RECOVERY_ACTIONS: Record<QuotaClassification, RecoveryAction> = {
	hourly: {
		action: "wait",
		requiresManual: false,
		estimatedWaitMs: QUOTA_COOLDOWN_MS.hourly,
		description: "Wait for the hourly rate limit to reset.",
	},
	daily: {
		action: "wait",
		requiresManual: false,
		estimatedWaitMs: QUOTA_COOLDOWN_MS.daily,
		description: "Wait for the daily quota window to reset.",
	},
	weekly: {
		action: "wait",
		requiresManual: false,
		estimatedWaitMs: 7 * 24 * 60 * 60 * 1000,
		description: "Wait for the weekly quota window to reset.",
	},
	monthly: {
		action: "wait",
		requiresManual: false,
		estimatedWaitMs: 30 * 24 * 60 * 60 * 1000,
		description: "Wait for the monthly quota window to reset.",
	},
	balance: {
		action: "pay",
		requiresManual: true,
		description: "Add balance or credits to the account before retrying.",
	},
	organization: {
		action: "contact_support",
		requiresManual: true,
		description: "Contact support or an organization administrator to restore access.",
	},
	unknown: {
		action: "switch_credential",
		requiresManual: false,
		estimatedWaitMs: QUOTA_COOLDOWN_MS.unknown,
		description: "Try another credential or provider while this quota state clears.",
	},
};

export const DEFAULT_QUOTA_CONFIG: QuotaClassificationConfig = {
	enabled: true,
	cooldownOverrides: {},
	customPatterns: {},
};
