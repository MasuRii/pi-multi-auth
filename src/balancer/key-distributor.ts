import type { CredentialModelEligibility } from "../model-entitlements.js";
import { AuthWriter } from "../auth-writer.js";
import { getCredentialSecret } from "../credential-display.js";
import { multiAuthDebugLogger } from "../debug-logger.js";
import { getProviderState, MultiAuthStorage } from "../storage.js";
import type { SupportedProviderId } from "../types.js";
import { RollingMetricSeries } from "../performance-metrics.js";
import type {
	BalancerCredentialState,
	CooldownInfo,
	CredentialLease,
	KeyDistributorMetrics,
	KeyDistributorProviderMetrics,
	SelectionContext,
} from "./types.js";
import { selectBestCredential } from "./weighted-selector.js";

const DEFAULT_CONFIG = {
	waitTimeoutMs: 30_000,
	defaultCooldownMs: 60_000,
	quotaCooldownMs: 3_600_000,
	maxConcurrentPerKey: 1,
	tolerance: 2.0,
} as const;

const LEASE_TTL_MS = 24 * 60 * 60 * 1000;
const TRANSIENT_COOLDOWN_REASON_PATTERN = /transient/i;

type KeyDistributorConfig = {
	waitTimeoutMs: number;
	defaultCooldownMs: number;
	quotaCooldownMs: number;
	maxConcurrentPerKey: number;
	tolerance: number;
};

type AcquireWaitOptions = {
	signal?: AbortSignal;
	excludedIds?: readonly string[];
	modelId?: string;
};

type InternalLease = CredentialLease & {
	providerId: SupportedProviderId;
	apiKey?: string;
};

type Waiter = {
	enqueuedAt: number;
	resolve: () => void;
	reject: (error: Error) => void;
};

interface ProviderMetricState {
	acquisitionLatencyMs: RollingMetricSeries;
	waitLatencyMs: RollingMetricSeries;
	acquisitionCount: number;
	successCount: number;
	timeoutCount: number;
	abortedCount: number;
	peakWaiters: number;
	lastAcquiredAt?: number;
}

type ModelEligibilityResolver = (
	providerId: SupportedProviderId,
	credentialIds: readonly string[],
	modelId: string | undefined,
) => Promise<CredentialModelEligibility> | CredentialModelEligibility;

/**
 * Balancer service that coordinates credential leases, cooldowns, and weighted key selection.
 */
export class KeyDistributor {
	private readonly config: KeyDistributorConfig;
	private readonly stateByProvider = new Map<SupportedProviderId, BalancerCredentialState>();
	private readonly leasesBySessionId = new Map<string, InternalLease>();
	private readonly leasesByCredentialId = new Map<string, InternalLease>();
	private readonly providerByCredentialId = new Map<string, SupportedProviderId>();
	private readonly waitersByProvider = new Map<SupportedProviderId, Set<Waiter>>();
	private readonly wakeTimerByProvider = new Map<SupportedProviderId, ReturnType<typeof setTimeout>>();
	private readonly metricsByProvider = new Map<SupportedProviderId, ProviderMetricState>();
	private modelEligibilityResolver?: ModelEligibilityResolver;

	constructor(
		private readonly storage: MultiAuthStorage = new MultiAuthStorage(),
		private readonly authWriter: AuthWriter = new AuthWriter(),
		config: Partial<KeyDistributorConfig> = {},
	) {
		this.config = {
			waitTimeoutMs: toPositiveInteger(config.waitTimeoutMs, DEFAULT_CONFIG.waitTimeoutMs),
			defaultCooldownMs: toPositiveInteger(
				config.defaultCooldownMs,
				DEFAULT_CONFIG.defaultCooldownMs,
			),
			quotaCooldownMs: toPositiveInteger(config.quotaCooldownMs, DEFAULT_CONFIG.quotaCooldownMs),
			maxConcurrentPerKey: Math.max(
				1,
				toPositiveInteger(config.maxConcurrentPerKey, DEFAULT_CONFIG.maxConcurrentPerKey),
			),
			tolerance: toNonNegativeNumber(config.tolerance, DEFAULT_CONFIG.tolerance),
		};
	}

	setModelEligibilityResolver(resolver: ModelEligibilityResolver): void {
		this.modelEligibilityResolver = resolver;
	}

	/**
	 * Acquires an exclusive credential lease for one subagent session.
	 */
	async acquireForSubagent(
		sessionId: string,
		providerId: SupportedProviderId,
		options: AcquireWaitOptions = {},
	): Promise<{ credentialId: string; apiKey: string }> {
		const startedAt = Date.now();
		const providerMetrics = this.getOrCreateProviderMetrics(providerId);
		providerMetrics.acquisitionCount += 1;
		const normalizedSessionId = normalizeSessionId(sessionId);
		assertNotAborted(options.signal, providerId);
		const existingLease = this.getActiveLeaseForSession(normalizedSessionId);
		if (existingLease && existingLease.providerId === providerId) {
			if (!(options.excludedIds ?? []).includes(existingLease.credentialId)) {
				const resolvedLease = await this.resolveActiveLease(existingLease);
				this.recordAcquireSuccess(providerId, Date.now() - startedAt);
				return resolvedLease;
			}
			this.unregisterLease(normalizedSessionId);
		}

		try {
			const credentialId = await this.acquireCredentialId(
				{
					providerId,
					excludedIds: [...(options.excludedIds ?? [])],
					requestingSessionId: normalizedSessionId,
					modelId: options.modelId,
				},
				options.signal,
			);
			assertNotAborted(options.signal, providerId);
			const lease: InternalLease = {
				sessionId: normalizedSessionId,
				providerId,
				credentialId,
				acquiredAt: Date.now(),
				expiresAt: Date.now() + LEASE_TTL_MS,
			};

			this.registerLease(lease);
			try {
				assertNotAborted(options.signal, providerId);
				const resolvedLease = await this.resolveActiveLease(lease);
				this.recordAcquireSuccess(providerId, Date.now() - startedAt);
				return resolvedLease;
			} catch (error) {
				if (isAbortError(error)) {
					this.unregisterLease(normalizedSessionId);
				}
				throw error;
			}
		} catch (error) {
			this.recordAcquireFailure(providerId, Date.now() - startedAt, error, options.signal);
			throw error;
		}
	}

	private async resolveCredentialLease(
		credentialId: string,
	): Promise<{ credentialId: string; apiKey: string }> {
		const credential = await this.authWriter.getCredential(credentialId);
		if (!credential) {
			throw new Error(
				`Credential '${credentialId}' could not be resolved for subagent lease.`,
			);
		}

		const apiKey = getCredentialSecret(credential).trim();
		if (!apiKey) {
			throw new Error(
				`Credential '${credentialId}' does not contain a usable secret for subagent lease.`,
			);
		}

		return {
			credentialId,
			apiKey,
		};
	}

	private async resolveActiveLease(
		lease: InternalLease,
	): Promise<{ credentialId: string; apiKey: string }> {
		const cachedApiKey = lease.apiKey?.trim();
		if (cachedApiKey) {
			return {
				credentialId: lease.credentialId,
				apiKey: cachedApiKey,
			};
		}

		const resolvedLease = await this.resolveCredentialLease(lease.credentialId);
		const currentLease = this.leasesBySessionId.get(lease.sessionId);
		if (
			currentLease &&
			currentLease.credentialId === lease.credentialId &&
			currentLease.providerId === lease.providerId
		) {
			currentLease.apiKey = resolvedLease.apiKey;
		}
		lease.apiKey = resolvedLease.apiKey;
		return resolvedLease;
	}

	/**
	 * Releases an existing subagent lease.
	 */
	releaseFromSubagent(sessionId: string): void {
		const normalizedSessionId = normalizeSessionId(sessionId);
		this.unregisterLease(normalizedSessionId);
	}

	/**
	 * Returns the currently leased credential ID for one session.
	 */
	getKeyForSession(sessionId: string): string | null {
		const normalizedSessionId = normalizeSessionId(sessionId);
		const lease = this.getActiveLeaseForSession(normalizedSessionId);
		return lease?.credentialId ?? null;
	}

	/**
	 * Resolves the active lease for one subagent session without re-running selection.
	 */
	async getLeaseForSession(
		sessionId: string,
	): Promise<{ credentialId: string; apiKey: string } | null> {
		const normalizedSessionId = normalizeSessionId(sessionId);
		const lease = this.getActiveLeaseForSession(normalizedSessionId);
		if (!lease) {
			return null;
		}

		return this.resolveActiveLease(lease);
	}

	/**
	 * Selects a credential for a non-exclusive orchestrator request.
	 */
	async acquireKey(context: SelectionContext, options: AcquireWaitOptions = {}): Promise<string> {
		return this.acquireCredentialId(context, options.signal);
	}

	/**
	 * Applies a temporary cooldown to a credential and persists it to multi-auth.json.
	 * For weekly quota errors, stores the error message for user visibility.
	 */
	async applyCooldown(
		credentialId: string,
		durationMs: number,
		reason: string,
		providerId?: SupportedProviderId,
		isWeekly?: boolean,
		errorMessage?: string,
	): Promise<void> {
		const normalizedCredentialId = credentialId.trim();
		if (normalizedCredentialId.length === 0) {
			throw new Error("Cannot apply cooldown: credentialId is empty.");
		}

		const resolvedProviderId =
			providerId ??
			this.providerByCredentialId.get(normalizedCredentialId) ??
			(await this.findProviderForCredential(normalizedCredentialId));
		if (!resolvedProviderId) {
			throw new Error(
				`Cannot apply cooldown to credential '${normalizedCredentialId}': provider could not be resolved.`,
			);
		}

		const now = Date.now();
		const fallbackDuration = /quota|weekly/i.test(reason)
			? this.config.quotaCooldownMs
			: this.config.defaultCooldownMs;
		const cooldownDuration = toPositiveInteger(durationMs, fallbackDuration);
		const cooldown: CooldownInfo = {
			until: now + cooldownDuration,
			reason: reason.trim() || "cooldown",
			appliedAt: now,
		};

		const providerState = this.getOrCreateState(resolvedProviderId);
		providerState.cooldowns[normalizedCredentialId] = cooldown;
		this.scheduleWake(resolvedProviderId);

		await this.storage.withLock((state) => {
			const persistedProviderState = getProviderState(state, resolvedProviderId);
			if (!persistedProviderState.credentialIds.includes(normalizedCredentialId)) {
				return { result: false };
			}

			const currentUntil = persistedProviderState.quotaExhaustedUntil[normalizedCredentialId] ?? 0;
			if (cooldown.until <= currentUntil) {
				return { result: false };
			}

			persistedProviderState.quotaExhaustedUntil[normalizedCredentialId] = cooldown.until;

			const trimmedError = errorMessage?.trim().slice(0, 500);
			const isTransientReason = TRANSIENT_COOLDOWN_REASON_PATTERN.test(reason);
			if (trimmedError) {
				if (isTransientReason) {
					persistedProviderState.lastTransientError = persistedProviderState.lastTransientError ?? {};
					persistedProviderState.lastTransientError[normalizedCredentialId] = trimmedError;
				} else {
					persistedProviderState.lastQuotaError = persistedProviderState.lastQuotaError ?? {};
					persistedProviderState.lastQuotaError[normalizedCredentialId] = trimmedError;
				}
			}

			if (isTransientReason) {
				persistedProviderState.transientErrorCount = persistedProviderState.transientErrorCount ?? {};
				const currentAttempts = persistedProviderState.transientErrorCount[normalizedCredentialId] ?? 0;
				persistedProviderState.transientErrorCount[normalizedCredentialId] = currentAttempts + 1;
			} else {
				persistedProviderState.quotaErrorCount[normalizedCredentialId] =
					(persistedProviderState.quotaErrorCount[normalizedCredentialId] ?? 0) + 1;
			}

			// Track weekly quota attempts for exponential backoff
			if (isWeekly) {
				persistedProviderState.weeklyQuotaAttempts = persistedProviderState.weeklyQuotaAttempts ?? {};
				const currentAttempts = persistedProviderState.weeklyQuotaAttempts[normalizedCredentialId] ?? 0;
				persistedProviderState.weeklyQuotaAttempts[normalizedCredentialId] = currentAttempts + 1;
			}

			return { result: true, next: state };
		});
	}

	/**
	 * Clears persisted transient backoff metadata after a credential succeeds again.
	 */
	async clearTransientError(
		credentialId: string,
		providerId?: SupportedProviderId,
	): Promise<void> {
		const normalizedCredentialId = credentialId.trim();
		if (normalizedCredentialId.length === 0) {
			return;
		}

		const resolvedProviderId =
			providerId ??
			this.providerByCredentialId.get(normalizedCredentialId) ??
			(await this.findProviderForCredential(normalizedCredentialId));
		if (!resolvedProviderId) {
			return;
		}

		await this.storage.withLock((state) => {
			const persistedProviderState = getProviderState(state, resolvedProviderId);
			if (!persistedProviderState.credentialIds.includes(normalizedCredentialId)) {
				return { result: false };
			}

			let changed = false;
			if (persistedProviderState.transientErrorCount?.[normalizedCredentialId] !== undefined) {
				delete persistedProviderState.transientErrorCount[normalizedCredentialId];
				changed = true;
			}
			if (persistedProviderState.lastTransientError?.[normalizedCredentialId] !== undefined) {
				delete persistedProviderState.lastTransientError[normalizedCredentialId];
				changed = true;
			}

			return changed ? { result: true, next: state } : { result: false };
		});
	}

	/**
	 * Permanently disables a credential due to unrecoverable errors (e.g., balance exhaustion).
	 * The credential will be marked as disabled in multi-auth.json and
	 * excluded from future acquisitions until manually re-enabled by the user.
	 */
	async disableCredential(
		credentialId: string,
		reason: string,
		providerId?: SupportedProviderId,
	): Promise<void> {
		const normalizedCredentialId = credentialId.trim();
		if (normalizedCredentialId.length === 0) {
			throw new Error("Cannot disable credential: credentialId is empty.");
		}

		const resolvedProviderId =
			providerId ??
			this.providerByCredentialId.get(normalizedCredentialId) ??
			(await this.findProviderForCredential(normalizedCredentialId));
		if (!resolvedProviderId) {
			throw new Error(
				`Cannot disable credential '${normalizedCredentialId}': provider could not be resolved.`,
			);
		}

		const now = Date.now();
		const errorMessage = reason.trim() || "Credential disabled due to unrecoverable error";

		// Clear any active lease for this credential
		this.unregisterLeaseByCredentialId(normalizedCredentialId);

		// Clear cooldown tracking for this credential
		const providerState = this.getOrCreateState(resolvedProviderId);
		delete providerState.cooldowns[normalizedCredentialId];

		// Persist disabled state to multi-auth.json
		await this.storage.withLock((state) => {
			const persistedProviderState = getProviderState(state, resolvedProviderId);
			if (!persistedProviderState.credentialIds.includes(normalizedCredentialId)) {
				return { result: false };
			}

			// Initialize disabledCredentials if it doesn't exist (migration)
			if (!persistedProviderState.disabledCredentials) {
				persistedProviderState.disabledCredentials = {};
			}

			persistedProviderState.disabledCredentials[normalizedCredentialId] = {
				error: errorMessage,
				disabledAt: now,
			};

			// Clear from quotaExhaustedUntil since it's now permanently disabled
			delete persistedProviderState.quotaExhaustedUntil[normalizedCredentialId];
			if (persistedProviderState.lastQuotaError) {
				delete persistedProviderState.lastQuotaError[normalizedCredentialId];
			}
			if (persistedProviderState.weeklyQuotaAttempts) {
				delete persistedProviderState.weeklyQuotaAttempts[normalizedCredentialId];
			}

			// Clear manual active if it's this credential
			if (persistedProviderState.manualActiveCredentialId === normalizedCredentialId) {
				persistedProviderState.manualActiveCredentialId = undefined;
			}

			return { result: true, next: state };
		});

		// Wake up any waiters since this credential is now unavailable
		this.scheduleWake(resolvedProviderId);

		multiAuthDebugLogger.log("credential_disabled_balancer", {
			provider: resolvedProviderId,
			credentialId: normalizedCredentialId,
			reason: errorMessage.slice(0, 200),
		});
	}

	/**
	 * Clears expired cooldown records from memory and persisted storage.
	 */
	async clearExpiredCooldowns(): Promise<void> {
		const now = Date.now();
		const changedProviders = new Set<SupportedProviderId>();

		for (const [providerId, state] of this.stateByProvider.entries()) {
			for (const [credentialId, cooldown] of Object.entries(state.cooldowns)) {
				if (cooldown && cooldown.until <= now) {
					delete state.cooldowns[credentialId];
					changedProviders.add(providerId);
				}
			}
		}

		this.clearExpiredLeases(now, changedProviders);

		const persistedChanges = await this.storage.withLock((state) => {
			let didChange = false;
			for (const [providerId, providerState] of Object.entries(state.providers)) {
				let providerChanged = false;
				for (const [credentialId, until] of Object.entries(providerState.quotaExhaustedUntil)) {
					if (until <= now) {
						delete providerState.quotaExhaustedUntil[credentialId];
						providerChanged = true;
					}
				}
				if (providerChanged) {
					didChange = true;
					changedProviders.add(providerId);
				}
			}

			return didChange ? { result: true, next: state } : { result: false };
		});

		if (!persistedChanges && changedProviders.size === 0) {
			return;
		}

		for (const providerId of changedProviders) {
			this.notifyAvailability(providerId);
		}
	}

	/**
	 * Returns the balancer runtime state for one provider.
	 */
	getState(providerId: SupportedProviderId): BalancerCredentialState {
		const state = this.getOrCreateState(providerId);
		return {
			weights: { ...state.weights },
			cooldowns: { ...state.cooldowns },
			activeRequests: { ...state.activeRequests },
			lastUsedAt: { ...state.lastUsedAt },
			healthScores: { ...(state.healthScores ?? {}) },
		};
	}

	getMetrics(): KeyDistributorMetrics {
		const providers: Record<string, KeyDistributorProviderMetrics> = {};
		for (const providerId of this.collectProviderMetricIds()) {
			const metrics = this.getOrCreateProviderMetrics(providerId);
			providers[providerId] = {
				providerId,
				acquisitionLatencyMs: metrics.acquisitionLatencyMs.snapshot(),
				waitLatencyMs: metrics.waitLatencyMs.snapshot(),
				acquisitionCount: metrics.acquisitionCount,
				successCount: metrics.successCount,
				timeoutCount: metrics.timeoutCount,
				abortedCount: metrics.abortedCount,
				activeWaiters: this.waitersByProvider.get(providerId)?.size ?? 0,
				peakWaiters: metrics.peakWaiters,
				lastAcquiredAt: metrics.lastAcquiredAt,
			};
		}
		return { providers };
	}

	private async acquireCredentialId(
		context: SelectionContext,
		signal?: AbortSignal,
	): Promise<string> {
		assertNotAborted(signal, context.providerId);
		await this.clearExpiredCooldowns();
		const waitDeadline = Date.now() + this.config.waitTimeoutMs;

		while (true) {
			assertNotAborted(signal, context.providerId);
			const now = Date.now();
			const changedProviders = new Set<SupportedProviderId>();
			this.clearExpiredLeases(now, changedProviders);
			this.clearExpiredInMemoryCooldowns(now, changedProviders);

			for (const providerId of changedProviders) {
				this.notifyAvailability(providerId);
			}

			const snapshot = await this.buildSnapshot(context.providerId, now);
			assertNotAborted(signal, context.providerId);
			if (snapshot.credentialIds.length === 0) {
				throw new Error(
					`No credentials available for ${context.providerId} in balancer mode. Open /multi-auth and add an account.`,
				);
			}

			const effectiveContext = await this.resolveEffectiveSelectionContext(
				context,
				snapshot.credentialIds,
			);
			assertNotAborted(signal, context.providerId);
			const selectedCredentialId = selectBestCredential(effectiveContext, snapshot, {
				waitTimeoutMs: this.config.waitTimeoutMs,
				defaultCooldownMs: this.config.defaultCooldownMs,
				maxConcurrentPerKey: this.config.maxConcurrentPerKey,
				tolerance: this.config.tolerance,
			});
			if (selectedCredentialId) {
				return selectedCredentialId;
			}

			const remainingMs = waitDeadline - Date.now();
			if (remainingMs <= 0) {
				throw new Error(
					`Timed out after ${this.config.waitTimeoutMs}ms waiting for an available credential for ${context.providerId}.`,
				);
			}

			await this.waitForAvailability(context.providerId, remainingMs, signal);
		}
	}

	private async resolveEffectiveSelectionContext(
		context: SelectionContext,
		credentialIds: readonly string[],
	): Promise<SelectionContext> {
		if (!context.modelId || !this.modelEligibilityResolver) {
			return context;
		}

		const eligibility = await this.modelEligibilityResolver(
			context.providerId,
			credentialIds,
			context.modelId,
		);
		if (!eligibility.appliesConstraint) {
			return context;
		}

		if (eligibility.eligibleCredentialIds.length === 0) {
			throw new Error(
				eligibility.failureMessage ??
					`No eligible credentials available for ${context.providerId}/${context.modelId}.`,
			);
		}

		const excludedIds = new Set(context.excludedIds);
		for (const credentialId of eligibility.ineligibleCredentialIds) {
			excludedIds.add(credentialId);
		}

		return {
			...context,
			excludedIds: [...excludedIds],
		};
	}

	private async buildSnapshot(providerId: SupportedProviderId, now: number): Promise<{
		credentialIds: readonly string[];
		usageCount: Readonly<Record<string, number>>;
		balancerState: Readonly<BalancerCredentialState>;
		leasesByCredentialId: Readonly<Record<string, CredentialLease | undefined>>;
	}> {
		const providerState = await this.storage.readProviderState(providerId);
		const credentialIds = [...providerState.credentialIds];
		const validCredentialIds = new Set(credentialIds);
		const balancerState = this.getOrCreateState(providerId);

		const activeCascade = providerState.cascadeState?.[providerId]?.active;
		const cascadeBlockedUntil =
			activeCascade?.isActive === true && activeCascade.nextRetryAt > now
				? activeCascade.nextRetryAt
				: null;
		const cascadeBlockedCredentialIds = new Set(
			cascadeBlockedUntil === null
				? []
				: activeCascade?.cascadePath.map((attempt) => attempt.credentialId) ?? [],
		);

		for (const credentialId of credentialIds) {
			this.providerByCredentialId.set(credentialId, providerId);
			balancerState.weights[credentialId] = providerState.usageCount[credentialId] ?? 0;
			balancerState.lastUsedAt[credentialId] = providerState.lastUsedAt[credentialId] ?? 0;
			balancerState.activeRequests[credentialId] = 0;
			balancerState.healthScores = balancerState.healthScores ?? {};
			balancerState.healthScores[credentialId] =
				providerState.healthState?.scores?.[credentialId]?.score ?? 1;

			const persistedUntil = providerState.quotaExhaustedUntil[credentialId];
			const existingCooldown = balancerState.cooldowns[credentialId];
			const existingUntil = existingCooldown?.until ?? 0;
			const cascadeUntil =
				cascadeBlockedUntil !== null && cascadeBlockedCredentialIds.has(credentialId)
					? cascadeBlockedUntil
					: 0;
			const mergedUntil = Math.max(
				typeof persistedUntil === "number" ? persistedUntil : 0,
				existingUntil,
				cascadeUntil,
			);
			if (mergedUntil > now) {
				balancerState.cooldowns[credentialId] = {
					until: mergedUntil,
					reason:
						cascadeUntil > existingUntil && cascadeUntil > (persistedUntil ?? 0)
							? "cascade-active"
							: existingCooldown?.reason ?? "cooldown",
					appliedAt: existingCooldown?.appliedAt ?? now,
				};
			} else {
				delete balancerState.cooldowns[credentialId];
			}
		}

		trimRecordByKeys(balancerState.weights, validCredentialIds);
		trimRecordByKeys(balancerState.activeRequests, validCredentialIds);
		trimRecordByKeys(balancerState.lastUsedAt, validCredentialIds);
		trimRecordByKeys(balancerState.cooldowns, validCredentialIds);
		trimRecordByKeys(balancerState.healthScores ?? {}, validCredentialIds);
		this.releaseOrphanLeases(providerId, validCredentialIds);

		const leasesByCredentialId: Record<string, CredentialLease | undefined> = {};
		for (const lease of this.leasesBySessionId.values()) {
			if (lease.providerId !== providerId || lease.expiresAt <= now) {
				continue;
			}
			if (!validCredentialIds.has(lease.credentialId)) {
				continue;
			}
			balancerState.activeRequests[lease.credentialId] =
				(balancerState.activeRequests[lease.credentialId] ?? 0) + 1;
			leasesByCredentialId[lease.credentialId] = lease;
		}

		this.scheduleWake(providerId);
		return {
			credentialIds,
			usageCount: providerState.usageCount,
			balancerState,
			leasesByCredentialId,
		};
	}

	private registerLease(lease: InternalLease): void {
		this.unregisterLease(lease.sessionId);
		this.leasesBySessionId.set(lease.sessionId, lease);
		this.leasesByCredentialId.set(lease.credentialId, lease);
		this.notifyAvailability(lease.providerId);
	}

	private unregisterLease(sessionId: string): void {
		const existingLease = this.leasesBySessionId.get(sessionId);
		if (!existingLease) {
			return;
		}

		this.leasesBySessionId.delete(sessionId);
		const mappedLease = this.leasesByCredentialId.get(existingLease.credentialId);
		if (mappedLease?.sessionId === sessionId) {
			this.leasesByCredentialId.delete(existingLease.credentialId);
		}
		this.notifyAvailability(existingLease.providerId);
	}

	private unregisterLeaseByCredentialId(credentialId: string): void {
		const lease = this.leasesByCredentialId.get(credentialId);
		if (!lease) {
			return;
		}

		this.leasesBySessionId.delete(lease.sessionId);
		this.leasesByCredentialId.delete(credentialId);
		this.notifyAvailability(lease.providerId);
	}

	private getActiveLeaseForSession(sessionId: string): InternalLease | null {
		const lease = this.leasesBySessionId.get(sessionId);
		if (!lease) {
			return null;
		}
		if (lease.expiresAt <= Date.now()) {
			this.unregisterLease(sessionId);
			return null;
		}
		return lease;
	}

	private clearExpiredLeases(now: number, changedProviders: Set<SupportedProviderId>): void {
		for (const lease of [...this.leasesBySessionId.values()]) {
			if (lease.expiresAt > now) {
				continue;
			}
			changedProviders.add(lease.providerId);
			this.unregisterLease(lease.sessionId);
		}
	}

	private clearExpiredInMemoryCooldowns(now: number, changedProviders: Set<SupportedProviderId>): void {
		for (const [providerId, state] of this.stateByProvider.entries()) {
			for (const [credentialId, cooldown] of Object.entries(state.cooldowns)) {
				if (cooldown && cooldown.until <= now) {
					delete state.cooldowns[credentialId];
					changedProviders.add(providerId);
				}
			}
		}
	}

	private releaseOrphanLeases(providerId: SupportedProviderId, validCredentialIds: Set<string>): void {
		for (const lease of [...this.leasesBySessionId.values()]) {
			if (lease.providerId !== providerId) {
				continue;
			}
			if (validCredentialIds.has(lease.credentialId)) {
				continue;
			}
			this.unregisterLease(lease.sessionId);
		}
	}

	private getOrCreateState(providerId: SupportedProviderId): BalancerCredentialState {
		const existing = this.stateByProvider.get(providerId);
		if (existing) {
			return existing;
		}

		const created: BalancerCredentialState = {
			weights: {},
			cooldowns: {},
			activeRequests: {},
			lastUsedAt: {},
			healthScores: {},
		};
		this.stateByProvider.set(providerId, created);
		return created;
	}

	private getOrCreateProviderMetrics(providerId: SupportedProviderId): ProviderMetricState {
		const existing = this.metricsByProvider.get(providerId);
		if (existing) {
			return existing;
		}

		const created: ProviderMetricState = {
			acquisitionLatencyMs: new RollingMetricSeries(),
			waitLatencyMs: new RollingMetricSeries(),
			acquisitionCount: 0,
			successCount: 0,
			timeoutCount: 0,
			abortedCount: 0,
			peakWaiters: 0,
		};
		this.metricsByProvider.set(providerId, created);
		return created;
	}

	private recordAcquireSuccess(providerId: SupportedProviderId, durationMs: number): void {
		const metrics = this.getOrCreateProviderMetrics(providerId);
		metrics.successCount += 1;
		metrics.lastAcquiredAt = Date.now();
		metrics.acquisitionLatencyMs.record(durationMs);
	}

	private recordAcquireFailure(
		providerId: SupportedProviderId,
		durationMs: number,
		error: unknown,
		signal: AbortSignal | undefined,
	): void {
		const metrics = this.getOrCreateProviderMetrics(providerId);
		metrics.acquisitionLatencyMs.record(durationMs);
		if (isAbortError(error)) {
			metrics.abortedCount += 1;
			if (signal?.aborted) {
				metrics.timeoutCount += 1;
			}
			return;
		}

		if (isAcquireTimeoutError(error)) {
			metrics.timeoutCount += 1;
		}
	}

	private collectProviderMetricIds(): Set<SupportedProviderId> {
		return new Set<SupportedProviderId>([
			...this.stateByProvider.keys(),
			...this.metricsByProvider.keys(),
			...this.waitersByProvider.keys(),
		]);
	}

	private async findProviderForCredential(credentialId: string): Promise<SupportedProviderId | null> {
		const providerId = await this.storage.findProviderForCredential(credentialId);
		if (providerId) {
			this.providerByCredentialId.set(credentialId, providerId);
		}
		return providerId;
	}

	private async waitForAvailability(
		providerId: SupportedProviderId,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		if (signal?.aborted) {
			throw createAbortError(providerId);
		}

		await new Promise<void>((resolve, reject) => {
			const waiters = this.getOrCreateWaiters(providerId);
			const providerMetrics = this.getOrCreateProviderMetrics(providerId);
			let settled = false;
			let timeoutId: ReturnType<typeof setTimeout> | null = null;

			const cleanup = (): void => {
				if (settled) {
					return;
				}
				settled = true;
				waiters.delete(waiter);
				providerMetrics.waitLatencyMs.record(Date.now() - waiter.enqueuedAt);
				if (waiters.size === 0) {
					this.waitersByProvider.delete(providerId);
				}
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
				signal?.removeEventListener("abort", onAbort);
			};

			const waiter: Waiter = {
				enqueuedAt: Date.now(),
				resolve: () => {
					cleanup();
					resolve();
				},
				reject: (error: Error) => {
					cleanup();
					reject(error);
				},
			};

			const onAbort = (): void => {
				waiter.reject(createAbortError(providerId));
			};

			waiters.add(waiter);
			providerMetrics.peakWaiters = Math.max(providerMetrics.peakWaiters, waiters.size);
			timeoutId = setTimeout(() => waiter.resolve(), Math.max(1, Math.trunc(timeoutMs)));
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private notifyAvailability(providerId: SupportedProviderId): void {
		this.scheduleWake(providerId);
		const waiters = this.waitersByProvider.get(providerId);
		if (!waiters || waiters.size === 0) {
			return;
		}

		for (const waiter of [...waiters]) {
			waiter.resolve();
		}
	}

	private scheduleWake(providerId: SupportedProviderId): void {
		const existingTimer = this.wakeTimerByProvider.get(providerId);
		if (existingTimer) {
			clearTimeout(existingTimer);
			this.wakeTimerByProvider.delete(providerId);
		}

		const now = Date.now();
		let earliestWakeAt = Number.POSITIVE_INFINITY;

		const state = this.stateByProvider.get(providerId);
		if (state) {
			for (const cooldown of Object.values(state.cooldowns)) {
				if (!cooldown || cooldown.until <= now) {
					continue;
				}
				earliestWakeAt = Math.min(earliestWakeAt, cooldown.until);
			}
		}

		for (const lease of this.leasesBySessionId.values()) {
			if (lease.providerId !== providerId || lease.expiresAt <= now) {
				continue;
			}
			earliestWakeAt = Math.min(earliestWakeAt, lease.expiresAt);
		}

		if (!Number.isFinite(earliestWakeAt)) {
			return;
		}

		const delayMs = Math.max(1, Math.trunc(earliestWakeAt - now));
		const wakeTimer = setTimeout(() => {
			this.wakeTimerByProvider.delete(providerId);
			this.notifyAvailability(providerId);
		}, delayMs);
		this.wakeTimerByProvider.set(providerId, wakeTimer);
	}

	private getOrCreateWaiters(providerId: SupportedProviderId): Set<Waiter> {
		const existing = this.waitersByProvider.get(providerId);
		if (existing) {
			return existing;
		}

		const created = new Set<Waiter>();
		this.waitersByProvider.set(providerId, created);
		return created;
	}
}

function trimRecordByKeys<T>(record: Record<string, T>, keys: Set<string>): void {
	for (const key of Object.keys(record)) {
		if (!keys.has(key)) {
			delete record[key];
		}
	}
}

function normalizeSessionId(sessionId: string): string {
	const normalized = sessionId.trim();
	if (normalized.length === 0) {
		throw new Error("sessionId must be a non-empty string.");
	}
	return normalized;
}

function toPositiveInteger(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return Math.max(1, Math.trunc(value));
}

function toNonNegativeNumber(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return fallback;
	}
	return value;
}

function createAbortError(providerId: SupportedProviderId): Error {
	const error = new Error(`Wait for credential availability aborted for ${providerId}.`);
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function isAcquireTimeoutError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Timed out after ");
}

function assertNotAborted(signal: AbortSignal | undefined, providerId: SupportedProviderId): void {
	if (signal?.aborted) {
		throw createAbortError(providerId);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { DEFAULT_CONFIG };
