import type { ParsedRateLimitHeaders, QuotaClassification } from "../types-quota.js";

/**
 * Shared usage/quota types used by provider fetchers and UI rendering.
 */

/**
 * Normalized rate-limit window details.
 */
export interface RateLimitWindow {
	usedPercent: number;
	windowMinutes: number | null;
	resetsAt: number | null;
}

/**
 * Normalized credits information returned by provider usage endpoints.
 */
export interface UsageCredits {
	hasCredits: boolean;
	unlimited: boolean;
	balance: string | null;
}

/**
 * Normalized Copilot quota bucket for chat/completions.
 */
export interface CopilotQuotaBucket {
	used: number | null;
	total: number | null;
	remaining: number | null;
	percentUsed: number | null;
	unlimited: boolean;
}

/**
 * Normalized Copilot quota payload.
 */
export interface CopilotQuota {
	chat: CopilotQuotaBucket;
	completions: CopilotQuotaBucket | null;
	resetAt: number | null;
}

/**
 * Snapshot of provider usage/quota state for one credential.
 */
export interface UsageSnapshot {
	timestamp: number;
	provider: string;
	planType: string | null;
	primary: RateLimitWindow | null;
	secondary: RateLimitWindow | null;
	credits: UsageCredits | null;
	copilotQuota: CopilotQuota | null;
	updatedAt: number;
	rateLimitHeaders?: ParsedRateLimitHeaders;
	quotaClassification?: QuotaClassification;
	estimatedResetAt?: number;
}

/**
 * Auth payload required by usage providers.
 */
export interface UsageAuth {
	accessToken: string;
	accountId?: string;
	credential?: Record<string, unknown>;
}

/**
 * Provider contract for usage fetching implementations.
 */
export interface UsageProvider<TAuth = UsageAuth> {
	id: string;
	displayName: string;
	fetchUsage?: (auth: TAuth) => Promise<UsageSnapshot | null>;
}

/**
 * Result returned by the usage orchestrator.
 */
export interface UsageFetchResult {
	snapshot: UsageSnapshot | null;
	error: string | null;
	fromCache: boolean;
	fetchedAt: number;
}

/**
 * Cache/read policy options for usage fetches.
 */
export interface UsageFetchOptions {
	forceRefresh?: boolean;
	allowStale?: boolean;
	maxAgeMs?: number;
	signal?: AbortSignal;
}
