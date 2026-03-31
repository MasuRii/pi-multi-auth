import type { SupportedProviderId } from "../types.js";

/**
 * Cooldown metadata recorded when a credential should be skipped temporarily.
 */
export interface CooldownInfo {
	until: number;
	reason: string;
	appliedAt: number;
}

/**
 * In-memory balancer state for one provider's credential pool.
 */
export interface BalancerCredentialState {
	weights: Record<string, number>;
	cooldowns: Partial<Record<string, CooldownInfo>>;
	activeRequests: Record<string, number>;
	lastUsedAt: Record<string, number>;
	healthScores?: Record<string, number>;
}

/**
 * Lease token returned when a credential is reserved for a session.
 */
export interface CredentialLease {
	sessionId: string;
	credentialId: string;
	acquiredAt: number;
	expiresAt: number;
}

/**
 * Context used to select a credential for the next request.
 */
export interface SelectionContext {
	providerId: SupportedProviderId;
	excludedIds: readonly string[];
	requestingSessionId: string;
	modelId?: string;
}

/**
 * Runtime tuning options for the key distributor.
 */
export interface KeyDistributorConfig {
	waitTimeoutMs: number;
	defaultCooldownMs: number;
	maxConcurrentPerKey: number;
}

export interface MetricSeriesSnapshot {
	count: number;
	min: number;
	max: number;
	average: number;
	p50: number;
	p95: number;
	p99: number;
}

export interface KeyDistributorProviderMetrics {
	providerId: SupportedProviderId;
	acquisitionLatencyMs: MetricSeriesSnapshot;
	waitLatencyMs: MetricSeriesSnapshot;
	acquisitionCount: number;
	successCount: number;
	timeoutCount: number;
	abortedCount: number;
	activeWaiters: number;
	peakWaiters: number;
	lastAcquiredAt?: number;
}

export interface KeyDistributorMetrics {
	providers: Record<string, KeyDistributorProviderMetrics>;
}

/**
 * Cross-extension global contract for acquiring and releasing API key leases.
 */
export interface GlobalKeyDistributor {
	acquireCredential(context: SelectionContext): Promise<CredentialLease | null>;
	releaseCredential(lease: CredentialLease): Promise<void>;
	applyCooldown(
		providerId: SupportedProviderId,
		credentialId: string,
		reason: string,
		cooldownMs?: number,
		isWeekly?: boolean,
		errorMessage?: string,
	): void;
	clearTransientError?(credentialId: string, providerId?: SupportedProviderId): Promise<void> | void;
	getState(providerId: SupportedProviderId): BalancerCredentialState;
	getLeaseForSession?(
		sessionId: string,
	): Promise<{ credentialId: string; apiKey: string } | null> | { credentialId: string; apiKey: string } | null;
	getMetrics?(): KeyDistributorMetrics;
}
