import type { CredentialModelEligibility } from "../model-entitlements.js";
import { AuthWriter } from "../auth-writer.js";
import {
	getCredentialRequestSecret,
	isExpiredApiKeyCredential,
} from "../credential-display.js";
import { multiAuthDebugLogger } from "../debug-logger.js";
import { LightweightRotationState } from "../lightweight-rotation-state.js";
import { getRoundRobinCandidateIndex, getUsageBasedCandidateIndex } from "../rotation-selection.js";
import { getProviderState, MultiAuthStorage } from "../storage.js";
import type { ProviderRotationState, SupportedProviderId } from "../types.js";
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
import type { ProviderCapabilities } from "../provider-registry.js";

const DEFAULT_CONFIG = {
	waitTimeoutMs: 30_000,
	defaultCooldownMs: 60_000,
	quotaCooldownMs: 3_600_000,
	maxConcurrentPerKey: 1,
	tolerance: 2.0,
} as const;

const LEASE_TTL_MS = 24 * 60 * 60 * 1000;
const LIGHTWEIGHT_SESSION_LEASE_TTL_MS = 5 * 60 * 1000;
const LIGHTWEIGHT_SESSION_LEASE_SCOPE_PREFIX = "lightweight-session";
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
	parentSessionId?: string;
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
	signal?: AbortSignal,
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
	private readonly lightweightLeaseScopeBySubagentSessionId = new Map<string, string>();
	private readonly lightweightSubagentSessionIdsByScopeKey = new Map<string, Set<string>>();
	private readonly lightweightParentSessionIdByScopeKey = new Map<string, string>();
	private readonly lightweightLeaseScopeKeysByParentSessionId = new Map<string, Set<string>>();
	private readonly waitersByProvider = new Map<SupportedProviderId, Set<Waiter>>();
	private readonly wakeTimerByProvider = new Map<SupportedProviderId, ReturnType<typeof setTimeout>>();
	private readonly metricsByProvider = new Map<SupportedProviderId, ProviderMetricState>();
	private readonly acquireLocksByProvider = new Map<
		SupportedProviderId,
		{ locked: boolean; waiters: Array<() => void> }
	>();
	private modelEligibilityResolver?: ModelEligibilityResolver;
	private providerCapabilitiesResolver?: (
		providerId: SupportedProviderId,
	) => ProviderCapabilities;
	private lightweightRotationState?: LightweightRotationState;

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

	setProviderCapabilitiesResolver(
		resolver: (providerId: SupportedProviderId) => ProviderCapabilities,
	): void {
		this.providerCapabilitiesResolver = resolver;
	}

	setLightweightRotationState(state: LightweightRotationState): void {
		this.lightweightRotationState = state;
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
		const normalizedParentSessionId = normalizeOptionalSessionId(options.parentSessionId);
		const lightweightLeaseScopeKey = this.getLightweightLeaseScopeKey(
			providerId,
			normalizedParentSessionId,
		);
		const effectiveLeaseSessionId = lightweightLeaseScopeKey ?? normalizedSessionId;
		const isLightweightSessionLease = effectiveLeaseSessionId === lightweightLeaseScopeKey;

		try {
			const resolvedLease = await this.withProviderAcquireLock(providerId, async () => {
				assertNotAborted(options.signal, providerId);
				const existingLease = this.getActiveLeaseForSession(normalizedSessionId);
				if (existingLease && existingLease.providerId === providerId) {
					if (!(options.excludedIds ?? []).includes(existingLease.credentialId)) {
						this.refreshLeaseExpiration(existingLease, lightweightLeaseScopeKey !== undefined);
						return this.resolveActiveLease(existingLease);
					}
					this.unregisterLease(normalizedSessionId);
				}

				if (lightweightLeaseScopeKey && normalizedParentSessionId) {
					const existingLightweightLease = this.getActiveLeaseForSession(lightweightLeaseScopeKey);
					if (existingLightweightLease && existingLightweightLease.providerId === providerId) {
						if (!(options.excludedIds ?? []).includes(existingLightweightLease.credentialId)) {
							this.registerLightweightLeaseAssociation(
								normalizedSessionId,
								lightweightLeaseScopeKey,
								normalizedParentSessionId,
							);
							this.refreshLeaseExpiration(existingLightweightLease, true);
							return this.resolveActiveLease(existingLightweightLease);
						}
						this.unregisterLease(lightweightLeaseScopeKey);
					}
				}

				const credentialId = await this.acquireCredentialId(
					{
						providerId,
						excludedIds: [...(options.excludedIds ?? [])],
						requestingSessionId: effectiveLeaseSessionId,
						modelId: options.modelId,
					},
					options.signal,
				);
				assertNotAborted(options.signal, providerId);
				const acquiredAt = Date.now();
				const lease: InternalLease = {
					sessionId: effectiveLeaseSessionId,
					providerId,
					credentialId,
					acquiredAt,
					expiresAt:
						acquiredAt +
						(isLightweightSessionLease ? LIGHTWEIGHT_SESSION_LEASE_TTL_MS : LEASE_TTL_MS),
				};

				this.registerLease(lease);
				if (isLightweightSessionLease && normalizedParentSessionId) {
					this.registerLightweightLeaseAssociation(
						normalizedSessionId,
						effectiveLeaseSessionId,
						normalizedParentSessionId,
					);
				}
				return this.resolveActiveLease(lease);
			});
			this.recordAcquireSuccess(providerId, Date.now() - startedAt);
			return resolvedLease;
		} catch (error) {
			if (isAbortError(error)) {
				this.unregisterLease(effectiveLeaseSessionId);
			}
			this.recordAcquireFailure(providerId, Date.now() - startedAt, error, options.signal);
			throw error;
		}
	}

	async shouldBypassDelegatedSubagentAcquisition(
		providerId: SupportedProviderId,
		options: { modelId?: string; signal?: AbortSignal } = {},
	): Promise<boolean> {
		assertNotAborted(options.signal, providerId);
		await this.clearExpiredCooldowns();
		const now = Date.now();
		const snapshot = await this.buildSnapshot(providerId, now);
		assertNotAborted(options.signal, providerId);
		if (snapshot.credentialIds.length === 0) {
			return false;
		}

		const effectiveContext = await this.resolveEffectiveSelectionContext(
			{
				providerId,
				excludedIds: [],
				requestingSessionId: `delegation-bypass:${providerId}`,
				modelId: options.modelId,
			},
			snapshot.credentialIds,
			options.signal,
		);
		assertNotAborted(options.signal, providerId);
		const eligibleCredentialIds = await this.getStructurallyEligibleCredentialIds(
			providerId,
			effectiveContext,
			snapshot,
			now,
			options.signal,
		);
		return eligibleCredentialIds.length === 1;
	}

	private async resolveCredentialLease(
		providerId: string,
		credentialId: string,
	): Promise<{ credentialId: string; apiKey: string }> {
		const credential = await this.authWriter.getCredential(credentialId);
		if (!credential) {
			throw new Error(
				`Credential '${credentialId}' could not be resolved for subagent lease.`,
			);
		}

		const apiKey = getCredentialRequestSecret(providerId, credential).trim();
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

		const resolvedLease = await this.resolveCredentialLease(lease.providerId, lease.credentialId);
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
	 * Releases cached lightweight session leases for one parent session.
	 */
	releaseLightweightSessionLeases(
		parentSessionId: string,
		providerId?: SupportedProviderId,
	): void {
		const normalizedParentSessionId = normalizeSessionId(parentSessionId);
		const scopeKeys = this.lightweightLeaseScopeKeysByParentSessionId.get(normalizedParentSessionId);
		if (!scopeKeys || scopeKeys.size === 0) {
			return;
		}

		const filteredProviderId = providerId?.trim();
		for (const scopeKey of [...scopeKeys]) {
			const lease = this.leasesBySessionId.get(scopeKey);
			if (!lease) {
				this.unregisterLease(scopeKey);
				continue;
			}
			if (filteredProviderId && lease.providerId !== filteredProviderId) {
				continue;
			}
			this.unregisterLease(scopeKey);
		}
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
		this.unregisterLeaseByCredentialId(normalizedCredentialId);
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

	private isLightweightRotationProvider(providerId: SupportedProviderId): boolean {
		return this.providerCapabilitiesResolver?.(providerId).rotationProfile === "lightweight";
	}

	private applyLightweightRotationState(
		providerId: SupportedProviderId,
		providerState: ProviderRotationState,
	): ProviderRotationState {
		if (!this.isLightweightRotationProvider(providerId) || !this.lightweightRotationState) {
			return providerState;
		}
		return this.lightweightRotationState.applyToProviderState(providerId, providerState);
	}

	private recordLightweightSelection(
		providerId: SupportedProviderId,
		credentialIds: readonly string[],
		credentialId: string,
		selectedAt: number,
		nextActiveIndex: number,
	): void {
		if (!this.isLightweightRotationProvider(providerId) || !this.lightweightRotationState) {
			return;
		}
		const selectedIndex = credentialIds.indexOf(credentialId);
		if (selectedIndex < 0) {
			throw new Error(
				`Cannot record lightweight balancer selection for ${providerId}: credential '${credentialId}' is not part of the provider state.`,
			);
		}
		this.lightweightRotationState.recordSelection({
			providerId,
			credentialIds,
			credentialId,
			selectedIndex,
			nextActiveIndex,
			selectedAt,
		});
	}

	private async getStructurallyEligibleCredentialIds(
		providerId: SupportedProviderId,
		context: SelectionContext,
		snapshot: {
			providerState: ProviderRotationState;
			credentialIds: readonly string[];
			balancerState: Readonly<BalancerCredentialState>;
			leasesByCredentialId: Readonly<Record<string, CredentialLease | undefined>>;
		},
		now: number,
		signal?: AbortSignal,
	): Promise<readonly string[]> {
		const excludedCredentialIds =
			context.excludedIds.length > 0 ? new Set(context.excludedIds) : null;
		const expiredCredentialIds = await this.getExpiredApiKeyCredentialIds(
			providerId,
			snapshot.credentialIds,
			signal,
		);
		const eligibleCredentialIds: string[] = [];

		for (const credentialId of snapshot.credentialIds) {
			if (excludedCredentialIds?.has(credentialId)) {
				continue;
			}
			if (snapshot.providerState.disabledCredentials?.[credentialId]) {
				continue;
			}
			if (expiredCredentialIds.has(credentialId)) {
				continue;
			}
			const cooldown = snapshot.balancerState.cooldowns[credentialId];
			if (cooldown && cooldown.until > now) {
				continue;
			}
			eligibleCredentialIds.push(credentialId);
		}

		return eligibleCredentialIds;
	}

	private async getExpiredApiKeyCredentialIds(
		providerId: SupportedProviderId,
		credentialIds: readonly string[],
		signal?: AbortSignal,
	): Promise<ReadonlySet<string>> {
		if (providerId !== "cline" || credentialIds.length === 0) {
			return new Set<string>();
		}

		assertNotAborted(signal, providerId);
		const credentialSnapshot = await this.authWriter.getCredentials(credentialIds);
		assertNotAborted(signal, providerId);
		const expiredCredentialIds = new Set<string>();
		const expirationCheckTimestamp = Date.now();
		for (const credentialId of credentialIds) {
			const credential = credentialSnapshot.get(credentialId);
			if (credential && isExpiredApiKeyCredential(providerId, credential, expirationCheckTimestamp)) {
				expiredCredentialIds.add(credentialId);
			}
		}
		return expiredCredentialIds;
	}

	private async buildAvailableCredentialSet(
		context: SelectionContext,
		snapshot: {
			providerState: ProviderRotationState;
			credentialIds: readonly string[];
			balancerState: Readonly<BalancerCredentialState>;
			leasesByCredentialId: Readonly<Record<string, CredentialLease | undefined>>;
		},
		now: number,
		signal?: AbortSignal,
	): Promise<Set<string>> {
		const available = new Set(
			await this.getStructurallyEligibleCredentialIds(
				context.providerId,
				context,
				snapshot,
				now,
				signal,
			),
		);

		for (const credentialId of [...available]) {
			const lease = snapshot.leasesByCredentialId[credentialId];
			if (lease && lease.expiresAt > now && lease.sessionId !== context.requestingSessionId) {
				available.delete(credentialId);
				continue;
			}
			const activeRequests = snapshot.balancerState.activeRequests[credentialId] ?? 0;
			if (activeRequests >= this.config.maxConcurrentPerKey) {
				available.delete(credentialId);
			}
		}

		return available;
	}

	private async selectConfiguredCredentialId(
		context: SelectionContext,
		snapshot: {
			providerState: ProviderRotationState;
			credentialIds: readonly string[];
			usageCount: Readonly<Record<string, number>>;
			balancerState: Readonly<BalancerCredentialState>;
			leasesByCredentialId: Readonly<Record<string, CredentialLease | undefined>>;
		},
		now: number,
		signal?: AbortSignal,
	): Promise<string | null> {
		const available = await this.buildAvailableCredentialSet(context, snapshot, now, signal);
		if (available.size === 0) {
			return null;
		}

		const manualCredentialId = snapshot.providerState.manualActiveCredentialId?.trim();
		if (manualCredentialId) {
			return available.has(manualCredentialId) ? manualCredentialId : null;
		}

		switch (snapshot.providerState.rotationMode) {
			case "round-robin": {
				const selectedIndex = getRoundRobinCandidateIndex(snapshot.providerState, available);
				return selectedIndex === undefined
					? null
					: snapshot.providerState.credentialIds[selectedIndex] ?? null;
			}
			case "usage-based": {
				const selectedIndex = getUsageBasedCandidateIndex(snapshot.providerState, available);
				return selectedIndex === undefined
					? null
					: snapshot.providerState.credentialIds[selectedIndex] ?? null;
			}
			case "balancer":
			default:
				return selectBestCredential(context, snapshot, {
					waitTimeoutMs: this.config.waitTimeoutMs,
					defaultCooldownMs: this.config.defaultCooldownMs,
					maxConcurrentPerKey: this.config.maxConcurrentPerKey,
					tolerance: this.config.tolerance,
				});
		}
	}

	private resolveNextActiveIndex(
		providerState: Pick<ProviderRotationState, "credentialIds" | "rotationMode" | "manualActiveCredentialId">,
		selectedIndex: number,
	): number {
		if (providerState.manualActiveCredentialId || selectedIndex < 0) {
			return Math.max(0, selectedIndex);
		}
		if (providerState.rotationMode !== "round-robin") {
			return selectedIndex;
		}
		if (providerState.credentialIds.length === 0) {
			return 0;
		}
		return (selectedIndex + 1) % providerState.credentialIds.length;
	}

	private async recordProviderSelection(
		providerId: SupportedProviderId,
		providerState: ProviderRotationState,
		credentialIds: readonly string[],
		credentialId: string,
		selectedAt: number,
	): Promise<void> {
		const selectedIndex = credentialIds.indexOf(credentialId);
		if (selectedIndex < 0) {
			throw new Error(
				`Cannot record delegated credential selection for ${providerId}: credential '${credentialId}' is not part of the provider state.`,
			);
		}
		const nextActiveIndex = this.resolveNextActiveIndex(providerState, selectedIndex);
		if (this.isLightweightRotationProvider(providerId)) {
			this.recordLightweightSelection(
				providerId,
				credentialIds,
				credentialId,
				selectedAt,
				nextActiveIndex,
			);
			return;
		}

		await this.storage.withLock((state) => {
			const storedProviderState = getProviderState(state, providerId);
			const storedSelectedIndex = storedProviderState.credentialIds.indexOf(credentialId);
			if (storedSelectedIndex < 0) {
				return { result: false };
			}
			storedProviderState.usageCount[credentialId] =
				(storedProviderState.usageCount[credentialId] ?? 0) + 1;
			storedProviderState.lastUsedAt[credentialId] = selectedAt;
			storedProviderState.activeIndex = this.resolveNextActiveIndex(
				storedProviderState,
				storedSelectedIndex,
			);
			return { result: true, next: state };
		});
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
				signal,
			);
			assertNotAborted(signal, context.providerId);
			const selectedCredentialId = await this.selectConfiguredCredentialId(
				effectiveContext,
				snapshot,
				now,
				signal,
			);
			if (selectedCredentialId) {
				const selectedAt = Date.now();
				await this.recordProviderSelection(
					context.providerId,
					snapshot.providerState,
					snapshot.credentialIds,
					selectedCredentialId,
					selectedAt,
				);
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
		signal?: AbortSignal,
	): Promise<SelectionContext> {
		if (!context.modelId || !this.modelEligibilityResolver) {
			return context;
		}

		const eligibility = await this.modelEligibilityResolver(
			context.providerId,
			credentialIds,
			context.modelId,
			signal,
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
		providerState: ProviderRotationState;
		credentialIds: readonly string[];
		usageCount: Readonly<Record<string, number>>;
		balancerState: Readonly<BalancerCredentialState>;
		leasesByCredentialId: Readonly<Record<string, CredentialLease | undefined>>;
	}> {
		const providerState = this.applyLightweightRotationState(
			providerId,
			await this.storage.readProviderState(providerId),
		);
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
			providerState,
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

	private registerLightweightLeaseAssociation(
		sessionId: string,
		scopeKey: string,
		parentSessionId: string,
	): void {
		this.unregisterLease(sessionId);
		this.lightweightLeaseScopeBySubagentSessionId.set(sessionId, scopeKey);
		const sessionIds = this.lightweightSubagentSessionIdsByScopeKey.get(scopeKey) ?? new Set<string>();
		sessionIds.add(sessionId);
		this.lightweightSubagentSessionIdsByScopeKey.set(scopeKey, sessionIds);
		this.lightweightParentSessionIdByScopeKey.set(scopeKey, parentSessionId);
		const scopeKeys = this.lightweightLeaseScopeKeysByParentSessionId.get(parentSessionId) ?? new Set<string>();
		scopeKeys.add(scopeKey);
		this.lightweightLeaseScopeKeysByParentSessionId.set(parentSessionId, scopeKeys);
	}

	private unregisterLease(sessionId: string): void {
		const existingLease = this.leasesBySessionId.get(sessionId);
		if (!existingLease) {
			this.unregisterLightweightLeaseAssociation(sessionId);
			return;
		}

		this.leasesBySessionId.delete(sessionId);
		const mappedLease = this.leasesByCredentialId.get(existingLease.credentialId);
		if (mappedLease?.sessionId === sessionId) {
			this.leasesByCredentialId.delete(existingLease.credentialId);
		}
		this.unregisterLightweightScopeMetadata(sessionId);
		this.notifyAvailability(existingLease.providerId);
	}

	private unregisterLeaseByCredentialId(credentialId: string): void {
		const lease = this.leasesByCredentialId.get(credentialId);
		if (!lease) {
			return;
		}
		this.unregisterLease(lease.sessionId);
	}

	private unregisterLightweightLeaseAssociation(sessionId: string): void {
		const scopeKey = this.lightweightLeaseScopeBySubagentSessionId.get(sessionId);
		if (!scopeKey) {
			return;
		}
		this.lightweightLeaseScopeBySubagentSessionId.delete(sessionId);
		const sessionIds = this.lightweightSubagentSessionIdsByScopeKey.get(scopeKey);
		if (!sessionIds) {
			return;
		}
		sessionIds.delete(sessionId);
		if (sessionIds.size === 0) {
			this.lightweightSubagentSessionIdsByScopeKey.delete(scopeKey);
		}
	}

	private unregisterLightweightScopeMetadata(scopeKey: string): void {
		const childSessionIds = this.lightweightSubagentSessionIdsByScopeKey.get(scopeKey);
		if (childSessionIds) {
			for (const childSessionId of childSessionIds) {
				this.lightweightLeaseScopeBySubagentSessionId.delete(childSessionId);
			}
			this.lightweightSubagentSessionIdsByScopeKey.delete(scopeKey);
		}

		const parentSessionId = this.lightweightParentSessionIdByScopeKey.get(scopeKey);
		if (!parentSessionId) {
			return;
		}
		this.lightweightParentSessionIdByScopeKey.delete(scopeKey);
		const scopeKeys = this.lightweightLeaseScopeKeysByParentSessionId.get(parentSessionId);
		if (!scopeKeys) {
			return;
		}
		scopeKeys.delete(scopeKey);
		if (scopeKeys.size === 0) {
			this.lightweightLeaseScopeKeysByParentSessionId.delete(parentSessionId);
		}
	}

	private getActiveLeaseForSession(sessionId: string): InternalLease | null {
		const scopeKey = this.lightweightLeaseScopeBySubagentSessionId.get(sessionId);
		if (scopeKey) {
			const lease = this.leasesBySessionId.get(scopeKey);
			if (!lease) {
				this.unregisterLightweightLeaseAssociation(sessionId);
				return null;
			}
			if (lease.expiresAt <= Date.now()) {
				this.unregisterLease(scopeKey);
				return null;
			}
			return lease;
		}

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

	private getLightweightLeaseScopeKey(
		providerId: SupportedProviderId,
		parentSessionId: string | undefined,
	): string | undefined {
		if (!parentSessionId || !this.isLightweightRotationProvider(providerId)) {
			return undefined;
		}
		return createLightweightSessionLeaseScopeKey(providerId, parentSessionId);
	}

	private refreshLeaseExpiration(lease: InternalLease, lightweight: boolean): void {
		lease.expiresAt = Date.now() + (lightweight ? LIGHTWEIGHT_SESSION_LEASE_TTL_MS : LEASE_TTL_MS);
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

	private getOrCreateAcquireLock(providerId: SupportedProviderId): {
		locked: boolean;
		waiters: Array<() => void>;
	} {
		const existing = this.acquireLocksByProvider.get(providerId);
		if (existing) {
			return existing;
		}

		const created = {
			locked: false,
			waiters: [] as Array<() => void>,
		};
		this.acquireLocksByProvider.set(providerId, created);
		return created;
	}

	private async acquireProviderLock(providerId: SupportedProviderId): Promise<void> {
		const lock = this.getOrCreateAcquireLock(providerId);
		if (!lock.locked) {
			lock.locked = true;
			return;
		}

		await new Promise<void>((resolve) => {
			lock.waiters.push(resolve);
		});
	}

	private releaseProviderLock(providerId: SupportedProviderId): void {
		const lock = this.acquireLocksByProvider.get(providerId);
		if (!lock) {
			return;
		}

		const nextWaiter = lock.waiters.shift();
		if (nextWaiter) {
			nextWaiter();
			return;
		}

		lock.locked = false;
		this.acquireLocksByProvider.delete(providerId);
	}

	private async withProviderAcquireLock<T>(
		providerId: SupportedProviderId,
		operation: () => Promise<T>,
	): Promise<T> {
		await this.acquireProviderLock(providerId);
		try {
			return await operation();
		} finally {
			this.releaseProviderLock(providerId);
		}
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
		wakeTimer.unref();
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

function normalizeOptionalSessionId(sessionId: string | undefined): string | undefined {
	if (typeof sessionId !== "string") {
		return undefined;
	}
	const normalized = sessionId.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function createLightweightSessionLeaseScopeKey(
	providerId: SupportedProviderId,
	parentSessionId: string,
): string {
	return `${LIGHTWEIGHT_SESSION_LEASE_SCOPE_PREFIX}:${providerId}:${parentSessionId}`;
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
