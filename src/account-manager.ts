import type { Api } from "@mariozechner/pi-ai";
import {
	formatOAuthProviderLabel,
	formatOAuthRefreshFailureSummary,
	getErrorMessage,
	inferOAuthRefreshFailureMetadata,
	isRecord,
	normalizeStructuredAuthField,
	raceWithSignal,
	throwIfAborted,
} from "./auth-error-utils.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth-compat.js";
import { getOAuthProvider, refreshOAuthCredential } from "./oauth-compat.js";
import { CascadeStateManager } from "./cascade-state.js";
import { CLINE_REFRESH_LEAD_TIME_MS } from "./cline-compat.js";
import { FailoverChainManager } from "./failover-chain.js";
import { HealthScorer } from "./health-scorer.js";
import {
	determineTokenExpiration,
	OAuthRefreshScheduler,
} from "./oauth-refresh-scheduler.js";
import { PoolManager } from "./pool-manager.js";
import { quotaClassifier } from "./quota-classifier.js";
import { getRoundRobinCandidateIndex, getUsageBasedCandidateIndex } from "./rotation-selection.js";
import {
	AuthWriter,
	type ApiKeyProviderNormalizationResult,
	type AuthCredentialEntry,
} from "./auth-writer.js";
import {
	getProviderState,
	MultiAuthStorage,
} from "./storage.js";
import {
	type BackupAndStoreResult,
	type CredentialStatus,
	type MultiAuthState,
	type ProviderRotationState,
	type ProviderStatus,
	type RotationMode,
	type SelectedCredential,
	type StoredAuthCredential,
	type StoredOAuthCredential,
	type SupportedProviderId,
} from "./types.js";
import {
	type CredentialModelEligibility,
	formatModelReference,
	isPlanEligibleForModel,
	modelRequiresEntitlement,
	normalizeCodexPlanType,
	normalizeModelId,
} from "./model-entitlements.js";
import { UsageService } from "./usage/index.js";
import { usageProviders } from "./usage/providers.js";
import type { UsageFetchOptions, UsageSnapshot } from "./usage/types.js";
import {
	formatCredentialRedaction,
	getCredentialExpiration,
	getCredentialRequestSecret,
	getCredentialSecret,
	isExpiredApiKeyCredential,
	validateApiKeyInput,
} from "./credential-display.js";
import {
	ProviderRegistry,
	type AvailableOAuthProvider,
	type ProviderCapabilities,
} from "./provider-registry.js";
import {
	getGlobalKeyDistributor,
	KeyDistributor,
	registerGlobalKeyDistributor,
} from "./balancer/index.js";
import { LightweightRotationState } from "./lightweight-rotation-state.js";
import {
	computeExponentialBackoffMs,
	getWeeklyQuotaCooldownMs,
	TRANSIENT_COOLDOWN_BASE_MS,
	TRANSIENT_COOLDOWN_MAX_MS,
} from "./balancer/credential-backoff.js";
import {
	cloneMultiAuthExtensionConfig,
	DEBUG_DIR,
	DEFAULT_MULTI_AUTH_CONFIG,
	type MultiAuthExtensionConfig,
} from "./config.js";
import { multiAuthDebugLogger } from "./debug-logger.js";
import type { CredentialErrorKind } from "./error-classifier.js";
import { haveSameJsonValue } from "./json-utils.js";
import { extractCodexCredentialIdentity } from "./openai-codex-identity.js";
import type { ChainResult, FailoverChain, FailoverChainState } from "./types-failover.js";
import {
	isOAuthRefreshFailureError,
	OAuthRefreshFailureError,
	UNSUPPORTED_OAUTH_REFRESH_PROVIDER_ERROR_CODE,
} from "./types-oauth.js";
import { DEFAULT_PROVIDER_POOL_CONFIG, type CredentialPool, type ProviderPoolConfig, type ProviderPoolState } from "./types-pool.js";
import type { QuotaClassification, QuotaClassificationResult, QuotaStateForCredential } from "./types-quota.js";

const QUOTA_COOLDOWN_MS = 60 * 60 * 1000;
const OAUTH_REFRESH_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PRESERVED_OAUTH_REFRESH_MIN_REMAINING_MS = 30_000;
const PRESERVED_OAUTH_REFRESH_ERROR_CODES_BY_PROVIDER = new Map<string, ReadonlySet<string>>([
	["cline", new Set(["failed_to_refresh_token"])],
]);

const MIN_QUOTA_RETRY_WINDOW_MS = 60_000;
const SELECTION_USAGE_MAX_AGE_MS = 15_000;
const BLOCKED_RECONCILE_USAGE_MAX_AGE_MS = 10_000;
const USAGE_PROVIDER_IDS = new Set(usageProviders.map((provider) => provider.id));

interface AutoActivateOptions {
	avoidUsageApi?: boolean;
}

interface AccountManagerRuntimeOptions {
	startOAuthRefreshScheduler?: boolean;
}

export type CredentialRefreshDisposition = "refreshed" | "preserved_active_token";

export interface CredentialRefreshResult {
	credential: StoredOAuthCredential;
	disposition: CredentialRefreshDisposition;
}

export interface ProviderRefreshResult {
	provider: SupportedProviderId;
	totalCredentials: number;
	refreshedCredentialIds: string[];
	preservedCredentialIds: string[];
	failedCredentials: Array<{ credentialId: string; error: string }>;
	usageWarnings: Array<{ credentialId: string; warning: string }>;
}

type UsageQuotaState =
	| {
		state: "available";
	}
	| {
		state: "exhausted";
		exhaustedUntil?: number;
	}
	| {
		state: "unknown";
	};

export type CredentialUsageSnapshotResult = {
	snapshot: UsageSnapshot | null;
	error: string | null;
	fromCache: boolean;
};

export interface CredentialSelectionCache {
	usageByRequest: Map<string, Promise<CredentialUsageSnapshotResult>>;
}

interface CredentialUsageContext {
	credentialIds: readonly string[];
	credentialsByIdPromise?: Promise<Map<string, StoredAuthCredential>>;
	selectionCache: CredentialSelectionCache;
	signal?: AbortSignal;
}

export function createCredentialSelectionCache(): CredentialSelectionCache {
	return {
		usageByRequest: new Map<string, Promise<CredentialUsageSnapshotResult>>(),
	};
}

function normalizeCredentialIdsForDeletion(credentialIds: readonly string[]): string[] {
	if (credentialIds.length === 0) {
		throw new Error("Select at least one credential to delete.");
	}

	const normalizedCredentialIds: string[] = [];
	const seenCredentialIds = new Set<string>();
	for (const credentialId of credentialIds) {
		if (typeof credentialId !== "string") {
			throw new Error("Credential IDs must be strings.");
		}

		const normalizedCredentialId = credentialId.trim();
		if (!normalizedCredentialId) {
			throw new Error("Credential IDs must be non-empty strings.");
		}
		if (seenCredentialIds.has(normalizedCredentialId)) {
			continue;
		}

		seenCredentialIds.add(normalizedCredentialId);
		normalizedCredentialIds.push(normalizedCredentialId);
	}

	return normalizedCredentialIds;
}

function formatCredentialIdList(credentialIds: readonly string[]): string {
	return credentialIds.map((credentialId) => `'${credentialId}'`).join(", ");
}

type AcquireCredentialOptions = {
	excludedCredentialIds?: Set<string>;
	modelId?: string;
	selectionCache?: CredentialSelectionCache;
	signal?: AbortSignal;
};

export interface ResolvedFailoverTarget extends ChainResult {
	api: Api;
}

function normalizeUsageRequestMaxAgeMs(maxAgeMs: number | undefined): number | undefined {
	return typeof maxAgeMs === "number" && Number.isFinite(maxAgeMs) && maxAgeMs > 0
		? maxAgeMs
		: undefined;
}

function getUsageRequestCacheKey(
	provider: SupportedProviderId,
	credentialId: string,
	options?: UsageFetchOptions,
): string {
	const normalizedMaxAgeMs = normalizeUsageRequestMaxAgeMs(options?.maxAgeMs);
	return [
		provider,
		credentialId,
		options?.forceRefresh === true ? "force" : "cached",
		options?.allowStale === true ? "stale" : "fresh-only",
		normalizedMaxAgeMs === undefined ? "default" : String(normalizedMaxAgeMs),
	].join(":");
}

function buildCodexIdentityKey(
	credentialId: string,
	credential: StoredOAuthCredential,
): string {
	const identity = extractCodexCredentialIdentity(credential);
	if (identity.accountUserId) {
		return `account-user:${identity.accountUserId}`;
	}
	if (identity.email) {
		return `email:${identity.email.toLowerCase()}`;
	}
	if (identity.accountId) {
		return `account:${identity.accountId}`;
	}
	return `credential:${credentialId}`;
}

function buildClineIdentityKey(credential: OAuthCredentials): string | undefined {
	const accountId = normalizeStructuredAuthField(
		typeof credential.accountId === "string" ? credential.accountId : undefined,
	);
	if (accountId) {
		return `account:${accountId}`;
	}

	const userInfo = isRecord(credential.userInfo) ? credential.userInfo : undefined;
	const userInfoId = normalizeStructuredAuthField(
		typeof userInfo?.id === "string" ? userInfo.id : undefined,
	);
	if (userInfoId) {
		return `account:${userInfoId}`;
	}

	const email =
		normalizeStructuredAuthField(
			typeof userInfo?.email === "string" ? userInfo.email : undefined,
		) ??
		normalizeStructuredAuthField(
			typeof credential.email === "string" ? credential.email : undefined,
		);
	return email ? `email:${email.toLowerCase()}` : undefined;
}

function inferCredentialFriendlyName(
	provider: SupportedProviderId,
	credentialId: string,
	credential: StoredOAuthCredential,
): string | undefined {
	if (provider === "openai-codex") {
		const identity = extractCodexCredentialIdentity(credential);
		const candidate = identity.email ?? identity.accountUserId;
		if (!candidate || candidate === credentialId) {
			return undefined;
		}
		return candidate;
	}

	if (provider === "cline") {
		const userInfo =
			typeof credential.userInfo === "object" && credential.userInfo !== null
				? (credential.userInfo as Record<string, unknown>)
				: undefined;
		const email = typeof userInfo?.email === "string" ? userInfo.email.trim() : "";
		const displayName = typeof userInfo?.displayName === "string" ? userInfo.displayName.trim() : "";
		const candidate = email || displayName;
		if (!candidate || candidate === credentialId) {
			return undefined;
		}
		return candidate;
	}

	return undefined;
}

function toEpochMs(timestamp: number | null | undefined): number | null {
	if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
		return null;
	}

	return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

function inferQuotaStateFromUsage(snapshot: UsageSnapshot | null): UsageQuotaState {
	if (!snapshot) {
		return { state: "unknown" };
	}

	let hasSignal = false;
	let exhausted = false;
	const exhaustedUntilCandidates: number[] = [];

	const considerWindow = (
		window: { usedPercent: number; resetsAt: number | null } | null,
	): void => {
		if (!window) {
			return;
		}
		hasSignal = true;
		if (window.usedPercent < 100) {
			return;
		}

		exhausted = true;
		const resetAtMs = toEpochMs(window.resetsAt);
		if (resetAtMs !== null) {
			exhaustedUntilCandidates.push(resetAtMs);
		}
	};

	considerWindow(snapshot.primary);
	considerWindow(snapshot.secondary);

	if (snapshot.copilotQuota) {
		hasSignal = true;
		const buckets = [snapshot.copilotQuota.chat, snapshot.copilotQuota.completions].filter(
			(bucket): bucket is NonNullable<typeof bucket> => bucket !== null,
		);
		const hasUnlimitedBucket = buckets.some((bucket) => bucket.unlimited);
		if (hasUnlimitedBucket) {
			return { state: "available" };
		}

		const remainingValues = buckets
			.map((bucket) => (typeof bucket.remaining === "number" ? bucket.remaining : null))
			.filter((value): value is number => value !== null);
		if (remainingValues.length > 0 && remainingValues.every((remaining) => remaining <= 0)) {
			exhausted = true;
			const resetAtMs = toEpochMs(snapshot.copilotQuota.resetAt);
			if (resetAtMs !== null) {
				exhaustedUntilCandidates.push(resetAtMs);
			}
		}
	}

	const remainingRequests = snapshot.rateLimitHeaders?.remaining;
	if (typeof remainingRequests === "number") {
		hasSignal = true;
		if (remainingRequests <= 0) {
			exhausted = true;
			const headerResetAt = toEpochMs(
				snapshot.estimatedResetAt ?? snapshot.rateLimitHeaders?.resetAt,
			);
			if (headerResetAt !== null) {
				exhaustedUntilCandidates.push(headerResetAt);
			}
		}
	}

	if (!hasSignal) {
		return { state: "unknown" };
	}
	if (!exhausted) {
		return { state: "available" };
	}

	return {
		state: "exhausted",
		exhaustedUntil:
			exhaustedUntilCandidates.length > 0
				? Math.max(...exhaustedUntilCandidates)
				: undefined,
	};
}

function isUsageSnapshotUntouched(snapshot: UsageSnapshot | null): boolean {
	if (!snapshot) {
		return false;
	}

	if (snapshot.copilotQuota) {
		const buckets = [snapshot.copilotQuota.chat, snapshot.copilotQuota.completions].filter(
			(bucket): bucket is NonNullable<typeof bucket> => bucket !== null,
		);
		if (buckets.length === 0) {
			return false;
		}
		if (buckets.some((bucket) => bucket.unlimited)) {
			return true;
		}
		return buckets.every((bucket) => {
			if (typeof bucket.percentUsed === "number") {
				return bucket.percentUsed <= 0;
			}
			if (typeof bucket.used === "number") {
				return bucket.used <= 0;
			}
			return false;
		});
	}

	const primaryUsed = snapshot.primary?.usedPercent;
	const secondaryUsed = snapshot.secondary?.usedPercent;
	if (typeof primaryUsed !== "number" || typeof secondaryUsed !== "number") {
		return false;
	}

	return primaryUsed <= 0 && secondaryUsed <= 0;
}

function getUsageSnapshotResetAt(snapshot: UsageSnapshot | null): number | null {
	if (!snapshot) {
		return null;
	}

	const secondaryResetAt = toEpochMs(snapshot.secondary?.resetsAt);
	if (secondaryResetAt !== null) {
		return secondaryResetAt;
	}

	const primaryResetAt = toEpochMs(snapshot.primary?.resetsAt);
	if (primaryResetAt !== null) {
		return primaryResetAt;
	}

	const rateLimitResetAt = toEpochMs(snapshot.estimatedResetAt ?? snapshot.rateLimitHeaders?.resetAt);
	if (rateLimitResetAt !== null) {
		return rateLimitResetAt;
	}

	return toEpochMs(snapshot.copilotQuota?.resetAt);
}

function cloneProviderState(state: ProviderRotationState): ProviderRotationState {
	return {
		credentialIds: [...state.credentialIds],
		activeIndex: state.activeIndex,
		rotationMode: state.rotationMode,
		manualActiveCredentialId: state.manualActiveCredentialId,
		lastUsedAt: { ...state.lastUsedAt },
		usageCount: { ...state.usageCount },
		quotaErrorCount: { ...state.quotaErrorCount },
		quotaExhaustedUntil: { ...state.quotaExhaustedUntil },
		lastQuotaError: { ...state.lastQuotaError },
		lastTransientError: { ...state.lastTransientError },
		transientErrorCount: { ...state.transientErrorCount },
		weeklyQuotaAttempts: { ...state.weeklyQuotaAttempts },
		friendlyNames: { ...state.friendlyNames },
		disabledCredentials: { ...state.disabledCredentials },
		cascadeState: state.cascadeState
			? JSON.parse(JSON.stringify(state.cascadeState)) as ProviderRotationState["cascadeState"]
			: undefined,
		healthState: state.healthState
			? JSON.parse(JSON.stringify(state.healthState)) as ProviderRotationState["healthState"]
			: undefined,
		oauthRefreshScheduled: { ...(state.oauthRefreshScheduled ?? {}) },
		pools: state.pools
			? JSON.parse(JSON.stringify(state.pools)) as ProviderRotationState["pools"]
			: undefined,
		poolConfig: state.poolConfig ? { ...state.poolConfig } : undefined,
		poolState: state.poolState ? { ...state.poolState } : undefined,
		chains: state.chains
			? JSON.parse(JSON.stringify(state.chains)) as ProviderRotationState["chains"]
			: undefined,
		activeChain: state.activeChain
			? JSON.parse(JSON.stringify(state.activeChain)) as ProviderRotationState["activeChain"]
			: undefined,
		quotaStates: state.quotaStates
			? JSON.parse(JSON.stringify(state.quotaStates)) as ProviderRotationState["quotaStates"]
			: undefined,
	};
}

function haveEquivalentProviderState(
	left: ProviderRotationState,
	right: ProviderRotationState,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function haveSameNumberRecord(
	left: Readonly<Record<string, number>>,
	right: Readonly<Record<string, number>>,
): boolean {
	const leftEntries = Object.entries(left);
	const rightEntries = Object.entries(right);
	if (leftEntries.length !== rightEntries.length) {
		return false;
	}

	for (const [key, value] of leftEntries) {
		if (right[key] !== value) {
			return false;
		}
	}

	return true;
}

function resolveMappedCredentialId(
	credentialId: string | undefined,
	credentialIdMap: Readonly<Record<string, string>>,
	validIds: ReadonlySet<string>,
): string | undefined {
	if (!credentialId) {
		return undefined;
	}

	const remappedCredentialId = credentialIdMap[credentialId] ?? credentialId;
	return validIds.has(remappedCredentialId) ? remappedCredentialId : undefined;
}

function remapNumericRecord(
	record: Record<string, number>,
	credentialIdMap: Readonly<Record<string, string>>,
	validIds: ReadonlySet<string>,
): Record<string, number> {
	const remapped: Record<string, number> = {};
	for (const [credentialId, value] of Object.entries(record)) {
		if (!Number.isFinite(value)) {
			continue;
		}
		const nextCredentialId = resolveMappedCredentialId(credentialId, credentialIdMap, validIds);
		if (!nextCredentialId) {
			continue;
		}
		remapped[nextCredentialId] = value;
	}
	return remapped;
}

function remapStringRecord(
	record: Record<string, string>,
	credentialIdMap: Readonly<Record<string, string>>,
	validIds: ReadonlySet<string>,
): Record<string, string> {
	const remapped: Record<string, string> = {};
	for (const [credentialId, value] of Object.entries(record)) {
		if (typeof value !== "string") {
			continue;
		}
		const nextCredentialId = resolveMappedCredentialId(credentialId, credentialIdMap, validIds);
		if (!nextCredentialId) {
			continue;
		}
		remapped[nextCredentialId] = value;
	}
	return remapped;
}

function remapQuotaStates(
	quotaStates: ProviderRotationState["quotaStates"],
	credentialIdMap: Readonly<Record<string, string>>,
	validIds: ReadonlySet<string>,
): ProviderRotationState["quotaStates"] {
	if (!quotaStates) {
		return undefined;
	}

	const remapped: NonNullable<ProviderRotationState["quotaStates"]> = {};
	for (const [credentialId, quotaState] of Object.entries(quotaStates)) {
		const nextCredentialId = resolveMappedCredentialId(credentialId, credentialIdMap, validIds);
		if (!nextCredentialId) {
			continue;
		}
		remapped[nextCredentialId] = {
			...quotaState,
			credentialId: nextCredentialId,
		};
	}
	return Object.keys(remapped).length > 0 ? remapped : undefined;
}

function remapPools(
	pools: ProviderRotationState["pools"],
	credentialIdMap: Readonly<Record<string, string>>,
	validIds: ReadonlySet<string>,
): ProviderRotationState["pools"] {
	if (!pools) {
		return undefined;
	}

	const remapped = pools
		.map((pool) => ({
			...pool,
			credentialIds: pool.credentialIds
				.map((credentialId) => resolveMappedCredentialId(credentialId, credentialIdMap, validIds))
				.filter((credentialId): credentialId is string => credentialId !== undefined),
			config: pool.config ? { ...pool.config } : undefined,
		}))
		.filter((pool) => pool.poolId.trim().length > 0 && pool.credentialIds.length > 0);

	return remapped.length > 0 ? remapped : undefined;
}

function resolveProviderPoolConfig(state: ProviderRotationState): ProviderPoolConfig {
	return {
		enablePools: state.poolConfig?.enablePools ?? ((state.pools?.length ?? 0) > 0),
		failoverStrategy:
			state.poolConfig?.failoverStrategy ?? DEFAULT_PROVIDER_POOL_CONFIG.failoverStrategy,
		preferHealthyWithinPool:
			state.poolConfig?.preferHealthyWithinPool ??
			DEFAULT_PROVIDER_POOL_CONFIG.preferHealthyWithinPool,
	};
}

function applyCredentialNormalization(
	state: ProviderRotationState,
	result: ApiKeyProviderNormalizationResult,
): void {
	const previousActiveCredentialId = state.credentialIds[state.activeIndex];
	const validIds = new Set(result.credentialIds);

	state.credentialIds = [...result.credentialIds];
	state.lastUsedAt = remapNumericRecord(state.lastUsedAt, result.credentialIdMap, validIds);
	state.usageCount = remapNumericRecord(state.usageCount, result.credentialIdMap, validIds);
	state.quotaErrorCount = remapNumericRecord(
		state.quotaErrorCount,
		result.credentialIdMap,
		validIds,
	);
	state.quotaExhaustedUntil = remapNumericRecord(
		state.quotaExhaustedUntil,
		result.credentialIdMap,
		validIds,
	);
	state.lastQuotaError = remapStringRecord(
		state.lastQuotaError,
		result.credentialIdMap,
		validIds,
	);
	state.lastTransientError = remapStringRecord(
		state.lastTransientError,
		result.credentialIdMap,
		validIds,
	);
	state.transientErrorCount = remapNumericRecord(
		state.transientErrorCount,
		result.credentialIdMap,
		validIds,
	);
	state.friendlyNames = remapStringRecord(state.friendlyNames, result.credentialIdMap, validIds);
	state.pools = remapPools(state.pools, result.credentialIdMap, validIds);
	state.quotaStates = remapQuotaStates(state.quotaStates, result.credentialIdMap, validIds);
	state.manualActiveCredentialId = resolveMappedCredentialId(
		state.manualActiveCredentialId,
		result.credentialIdMap,
		validIds,
	);

	const nextActiveCredentialId = resolveMappedCredentialId(
		previousActiveCredentialId,
		result.credentialIdMap,
		validIds,
	);
	state.activeIndex = nextActiveCredentialId
		? Math.max(0, state.credentialIds.indexOf(nextActiveCredentialId))
		: 0;
	normalizeProviderState(state);
}

function normalizeProviderState(state: ProviderRotationState): void {
	const validIds = new Set(state.credentialIds);

	const keepOnlyValidNumericKeys = (record: Record<string, number>): void => {
		for (const key of Object.keys(record)) {
			if (!validIds.has(key)) {
				delete record[key];
			}
		}
	};

	keepOnlyValidNumericKeys(state.lastUsedAt);
	keepOnlyValidNumericKeys(state.usageCount);
	keepOnlyValidNumericKeys(state.quotaErrorCount);
	keepOnlyValidNumericKeys(state.quotaExhaustedUntil);
	keepOnlyValidNumericKeys(state.transientErrorCount);

	for (const key of Object.keys(state.lastQuotaError)) {
		if (!validIds.has(key)) {
			delete state.lastQuotaError[key];
		}
	}

	for (const key of Object.keys(state.lastTransientError)) {
		if (!validIds.has(key)) {
			delete state.lastTransientError[key];
		}
	}

	for (const key of Object.keys(state.friendlyNames)) {
		if (!validIds.has(key)) {
			delete state.friendlyNames[key];
			continue;
		}
		const normalized = state.friendlyNames[key]?.trim();
		if (!normalized || normalized === key) {
			delete state.friendlyNames[key];
			continue;
		}
		state.friendlyNames[key] = normalized;
	}

	for (const key of Object.keys(state.disabledCredentials)) {
		if (!validIds.has(key)) {
			delete state.disabledCredentials[key];
			continue;
		}
		const entry = state.disabledCredentials[key];
		const normalizedError = entry?.error?.trim();
		if (!normalizedError) {
			delete state.disabledCredentials[key];
			continue;
		}
		state.disabledCredentials[key] = {
			error: normalizedError,
			disabledAt:
				typeof entry.disabledAt === "number" && Number.isFinite(entry.disabledAt)
					? entry.disabledAt
					: Date.now(),
		};
	}

	keepOnlyValidNumericKeys(state.oauthRefreshScheduled ?? {});

	if (state.cascadeState) {
		for (const providerId of Object.keys(state.cascadeState)) {
			const providerCascadeState = state.cascadeState[providerId];
			if (!providerCascadeState) {
				delete state.cascadeState[providerId];
				continue;
			}
			if (providerCascadeState.active) {
				providerCascadeState.active.cascadePath = providerCascadeState.active.cascadePath.filter(
					(attempt) => validIds.has(attempt.credentialId),
				);
				providerCascadeState.active.attemptCount = providerCascadeState.active.cascadePath.length;
				if (providerCascadeState.active.cascadePath.length === 0) {
					providerCascadeState.active = undefined;
				}
			}
			providerCascadeState.history = providerCascadeState.history
				.map((entry) => ({
					...entry,
					cascadePath: entry.cascadePath.filter((attempt) => validIds.has(attempt.credentialId)),
					attemptCount: entry.cascadePath.filter((attempt) => validIds.has(attempt.credentialId))
						.length,
				}))
				.filter((entry) => entry.cascadePath.length > 0);
			if (!providerCascadeState.active && providerCascadeState.history.length === 0) {
				delete state.cascadeState[providerId];
			}
		}
		if (Object.keys(state.cascadeState).length === 0) {
			state.cascadeState = undefined;
		}
	}

	if (state.healthState) {
		for (const credentialId of Object.keys(state.healthState.scores ?? {})) {
			if (!validIds.has(credentialId)) {
				delete state.healthState.scores[credentialId];
			}
		}
		for (const credentialId of Object.keys(state.healthState.history ?? {})) {
			if (!validIds.has(credentialId)) {
				delete state.healthState.history?.[credentialId];
			}
		}
		if (
			Object.keys(state.healthState.scores ?? {}).length === 0 &&
			Object.keys(state.healthState.history ?? {}).length === 0
		) {
			state.healthState = undefined;
		}
	}

	if (state.pools) {
		state.pools = state.pools
			.map((pool) => ({
				...pool,
				credentialIds: pool.credentialIds.filter((credentialId) => validIds.has(credentialId)),
				config: pool.config ? { ...pool.config } : undefined,
			}))
			.filter((pool) => pool.poolId.trim().length > 0 && pool.credentialIds.length > 0)
			.sort((left, right) => {
				if (left.priority !== right.priority) {
					return left.priority - right.priority;
				}
				return left.poolId.localeCompare(right.poolId);
			});
		if (state.pools.length === 0) {
			state.pools = undefined;
			state.poolState = undefined;
		}
	}

	if (state.poolConfig) {
		state.poolConfig = resolveProviderPoolConfig(state);
		if (
			state.poolConfig.enablePools === DEFAULT_PROVIDER_POOL_CONFIG.enablePools &&
			state.poolConfig.failoverStrategy === DEFAULT_PROVIDER_POOL_CONFIG.failoverStrategy &&
			state.poolConfig.preferHealthyWithinPool ===
				DEFAULT_PROVIDER_POOL_CONFIG.preferHealthyWithinPool
		) {
			state.poolConfig = undefined;
		}
	}

	if (state.poolState) {
		const poolExists = state.pools?.some((pool) => pool.poolId === state.poolState?.activePoolId) ?? false;
		if (!poolExists) {
			state.poolState.activePoolId = undefined;
		}
		if (
			typeof state.poolState.poolIndex === "number" &&
			(!Number.isInteger(state.poolState.poolIndex) || state.poolState.poolIndex < 0)
		) {
			state.poolState.poolIndex = 0;
		}
		if (!state.poolState.activePoolId && state.poolState.poolIndex === undefined) {
			state.poolState = undefined;
		}
	}

	if (state.quotaStates) {
		for (const credentialId of Object.keys(state.quotaStates)) {
			if (!validIds.has(credentialId)) {
				delete state.quotaStates[credentialId];
			}
		}
		if (Object.keys(state.quotaStates).length === 0) {
			state.quotaStates = undefined;
		}
	}

	for (const credentialId of state.credentialIds) {
		if (state.usageCount[credentialId] === undefined) {
			state.usageCount[credentialId] = 0;
		}
		if (state.quotaErrorCount[credentialId] === undefined) {
			state.quotaErrorCount[credentialId] = 0;
		}
		if (state.transientErrorCount[credentialId] === undefined) {
			state.transientErrorCount[credentialId] = 0;
		}
		state.oauthRefreshScheduled = state.oauthRefreshScheduled ?? {};
	}

	if (
		typeof state.manualActiveCredentialId === "string" &&
		!validIds.has(state.manualActiveCredentialId)
	) {
		state.manualActiveCredentialId = undefined;
	}

	if (state.credentialIds.length === 0) {
		state.activeIndex = 0;
		state.manualActiveCredentialId = undefined;
		return;
	}

	if (state.activeIndex < 0 || state.activeIndex >= state.credentialIds.length) {
		state.activeIndex = 0;
	}

	if (state.manualActiveCredentialId) {
		const manualIndex = state.credentialIds.indexOf(state.manualActiveCredentialId);
		if (manualIndex >= 0) {
			state.activeIndex = manualIndex;
		}
	}
}

function buildAvailableSet(
	state: ProviderRotationState,
	now: number,
	excludedCredentialIds?: Set<string>,
): Set<string> {
	const available = new Set<string>();

	for (const credentialId of state.credentialIds) {
		// Skip permanently disabled credentials
		if (state.disabledCredentials?.[credentialId]) {
			continue;
		}

		const exhaustedUntil = state.quotaExhaustedUntil[credentialId];
		if (typeof exhaustedUntil === "number" && exhaustedUntil <= now) {
			delete state.quotaExhaustedUntil[credentialId];
		}

		const stillExhausted = state.quotaExhaustedUntil[credentialId];
		if (typeof stillExhausted === "number" && stillExhausted > now) {
			continue;
		}
		if (excludedCredentialIds?.has(credentialId)) {
			continue;
		}
		available.add(credentialId);
	}

	return available;
}

/**
 * Gets the disabled error message for a credential from the provider state.
 */
function getDisabledError(
	state: ProviderRotationState,
	credentialId: string,
): { error: string; disabledAt: number } | null {
	const entry = state.disabledCredentials[credentialId];
	if (!entry || typeof entry.error !== "string" || entry.error.trim().length === 0) {
		return null;
	}
	return {
		error: entry.error.trim(),
		disabledAt: typeof entry.disabledAt === "number" ? entry.disabledAt : Date.now(),
	};
}

function isLegacyCodexOAuthRefreshFailureMessage(message: string | undefined): boolean {
	const normalizedMessage = message?.trim();
	if (!normalizedMessage) {
		return false;
	}

	return (
		/failed to refresh oauth token/i.test(normalizedMessage) &&
		/openai codex refresh rejected permanently/i.test(normalizedMessage)
	);
}

function migrateLegacyCodexRefreshDisabledCredentials(
	state: ProviderRotationState,
	now: number = Date.now(),
): boolean {
	let changed = false;
	for (const [credentialId, entry] of Object.entries(state.disabledCredentials ?? {})) {
		if (!isLegacyCodexOAuthRefreshFailureMessage(entry?.error)) {
			continue;
		}

		const disabledAt =
			typeof entry.disabledAt === "number" && Number.isFinite(entry.disabledAt) && entry.disabledAt > 0
				? entry.disabledAt
				: now;
		const cooldownUntil = Math.max(
			state.quotaExhaustedUntil[credentialId] ?? 0,
			disabledAt + OAUTH_REFRESH_FAILURE_COOLDOWN_MS,
		);
		if (cooldownUntil > now) {
			state.quotaExhaustedUntil[credentialId] = cooldownUntil;
		} else {
			delete state.quotaExhaustedUntil[credentialId];
		}
		state.lastQuotaError[credentialId] = entry.error.trim().slice(0, 500);
		delete state.disabledCredentials[credentialId];
		changed = true;
	}

	if (changed && Object.keys(state.disabledCredentials).length === 0) {
		state.disabledCredentials = {};
	}

	return changed;
}

function clearRecoveredCodexRefreshFailureState(
	state: ProviderRotationState,
	credentialId: string,
): boolean {
	let changed = false;
	const disabledEntry = state.disabledCredentials?.[credentialId];
	if (disabledEntry && isLegacyCodexOAuthRefreshFailureMessage(disabledEntry.error)) {
		delete state.disabledCredentials[credentialId];
		changed = true;
	}

	const lastQuotaError = state.lastQuotaError[credentialId];
	if (isLegacyCodexOAuthRefreshFailureMessage(lastQuotaError)) {
		delete state.quotaExhaustedUntil[credentialId];
		delete state.lastQuotaError[credentialId];
		delete state.quotaStates?.[credentialId];
		delete state.weeklyQuotaAttempts?.[credentialId];
		changed = true;
	}

	if (changed && Object.keys(state.disabledCredentials).length === 0) {
		state.disabledCredentials = {};
	}
	if (state.quotaStates && Object.keys(state.quotaStates).length === 0) {
		state.quotaStates = undefined;
	}
	if (state.weeklyQuotaAttempts && Object.keys(state.weeklyQuotaAttempts).length === 0) {
		state.weeklyQuotaAttempts = {};
	}

	return changed;
}

function getEffectiveOAuthCredentialExpiration(
	credential: StoredOAuthCredential,
): number {
	return determineTokenExpiration(credential.access, credential.expires).expiresAt;
}

function getOAuthRefreshLeadTimeMs(provider: SupportedProviderId, defaultSafetyWindowMs: number): number {
	return provider === "cline"
		? Math.max(defaultSafetyWindowMs, CLINE_REFRESH_LEAD_TIME_MS)
		: defaultSafetyWindowMs;
}

function getSchedulerExpirationForRefreshLeadTime(
	provider: SupportedProviderId,
	expiresAt: number,
	schedulerSafetyWindowMs: number,
): number {
	const leadTimeMs = getOAuthRefreshLeadTimeMs(provider, schedulerSafetyWindowMs);
	return expiresAt - Math.max(0, leadTimeMs - schedulerSafetyWindowMs);
}

function hasPreservableOAuthTokenLifetime(
	credential: StoredOAuthCredential,
	now: number = Date.now(),
): boolean {
	return getEffectiveOAuthCredentialExpiration(credential) - now > PRESERVED_OAUTH_REFRESH_MIN_REMAINING_MS;
}

function isRecoverableClineOAuthRefreshFailureMessage(message: string | undefined): boolean {
	const normalizedMessage = message?.trim();
	if (!normalizedMessage) {
		return false;
	}

	return (
		/cline refresh rejected permanently/i.test(normalizedMessage) &&
		/code=failed[_\s-]*to[_\s-]*refresh[_\s-]*token/i.test(normalizedMessage)
	);
}

function clearRecoveredClineRefreshFailureState(
	state: ProviderRotationState,
	credentialId: string,
	_credential: StoredOAuthCredential,
	_now: number = Date.now(),
): boolean {
	const disabledEntry = state.disabledCredentials?.[credentialId];
	if (!disabledEntry || !isRecoverableClineOAuthRefreshFailureMessage(disabledEntry.error)) {
		return false;
	}

	delete state.disabledCredentials[credentialId];
	if (Object.keys(state.disabledCredentials).length === 0) {
		state.disabledCredentials = {};
	}
	return true;
}

function shouldPreserveActiveOAuthCredentialAfterRefreshFailure(
	provider: SupportedProviderId,
	credential: StoredOAuthCredential,
	failure: OAuthRefreshFailureError,
	now: number = Date.now(),
): boolean {
	if (!hasPreservableOAuthTokenLifetime(credential, now)) {
		return false;
	}

	if (provider === "cline" && failure.details.permanent) {
		return true;
	}

	const errorCode = normalizeStructuredAuthField(failure.details.errorCode);
	if (!errorCode) {
		return false;
	}

	return PRESERVED_OAUTH_REFRESH_ERROR_CODES_BY_PROVIDER.get(provider)?.has(errorCode) ?? false;
}

function isDisabledByPreservableOAuthRefreshFailure(
	provider: SupportedProviderId,
	errorMessage: string | undefined,
): boolean {
	const normalizedMessage = errorMessage?.trim();
	if (!normalizedMessage) {
		return false;
	}
	if (provider === "cline" && isRecoverableClineOAuthRefreshFailureMessage(normalizedMessage)) {
		return true;
	}

	const inferredFailure = inferOAuthRefreshFailureMetadata(normalizedMessage);
	const errorCode = normalizeStructuredAuthField(inferredFailure.errorCode);
	if (!errorCode) {
		return false;
	}

	return PRESERVED_OAUTH_REFRESH_ERROR_CODES_BY_PROVIDER.get(provider)?.has(errorCode) ?? false;
}

function clearDisabledOAuthRefreshFailureStateForProvider(
	provider: SupportedProviderId,
	state: ProviderRotationState,
): boolean {
	let changed = false;
	for (const [credentialId, entry] of Object.entries(state.disabledCredentials ?? {})) {
		if (!isDisabledByPreservableOAuthRefreshFailure(provider, entry?.error)) {
			continue;
		}
		delete state.disabledCredentials[credentialId];
		changed = true;
	}

	if (changed && Object.keys(state.disabledCredentials).length === 0) {
		state.disabledCredentials = {};
	}

	return changed;
}

function clearRecoveredOAuthRefreshFailureStateForCredential(
	provider: SupportedProviderId,
	state: ProviderRotationState,
	credentialId: string,
	credential: StoredOAuthCredential,
	now: number = Date.now(),
): boolean {
	if (provider === "openai-codex") {
		return clearRecoveredCodexRefreshFailureState(state, credentialId);
	}
	if (provider === "cline") {
		return clearRecoveredClineRefreshFailureState(state, credentialId, credential, now);
	}
	return false;
}

function clearRecoveredOAuthRefreshFailureStateForProvider(
	provider: SupportedProviderId,
	state: ProviderRotationState,
	credentialEntries: readonly AuthCredentialEntry[],
	now: number = Date.now(),
): boolean {
	let changed = false;
	for (const entry of credentialEntries) {
		if (entry.credential.type !== "oauth") {
			continue;
		}
		changed =
			clearRecoveredOAuthRefreshFailureStateForCredential(
				provider,
				state,
				entry.credentialId,
				entry.credential,
				now,
			) || changed;
	}
	return changed;
}

/**
 * Manages multi-account credentials and rotation behavior across providers.
 */
export class AccountManager {
	private readonly keyDistributor: KeyDistributor;
	private extensionConfig: MultiAuthExtensionConfig;
	private readonly cascadeStateManager: CascadeStateManager;
	private readonly healthScorer: HealthScorer;
	private readonly oauthRefreshScheduler: OAuthRefreshScheduler;
	private readonly runtimeOptions: Readonly<Required<AccountManagerRuntimeOptions>>;
	private readonly oauthRefreshInFlight = new Map<string, Promise<StoredOAuthCredential>>();
	private readonly lightweightRotationState: LightweightRotationState;
	private readonly authWriter: AuthWriter;
	private readonly storage: MultiAuthStorage;
	private readonly usageService: UsageService;
	private readonly providerRegistry: ProviderRegistry;
	private initializationPromise: Promise<void> | null = null;

	constructor(
		authWriter: AuthWriter = new AuthWriter(),
		storage: MultiAuthStorage | undefined = undefined,
		usageService: UsageService = new UsageService(),
		providerRegistry: ProviderRegistry = new ProviderRegistry(authWriter),
		keyDistributor?: KeyDistributor,
		extensionConfig: MultiAuthExtensionConfig = DEFAULT_MULTI_AUTH_CONFIG,
		runtimeOptions: AccountManagerRuntimeOptions = {},
	) {
		this.authWriter = authWriter;
		this.extensionConfig = cloneMultiAuthExtensionConfig(extensionConfig);
		this.storage =
			storage ??
			new MultiAuthStorage(undefined, {
				debugDir: DEBUG_DIR,
				historyPersistence: this.extensionConfig.historyPersistence,
			});
		this.usageService = usageService;
		this.providerRegistry = providerRegistry;
		this.lightweightRotationState = new LightweightRotationState(this.storage);
		this.runtimeOptions = {
			startOAuthRefreshScheduler: runtimeOptions.startOAuthRefreshScheduler !== false,
		};
		this.cascadeStateManager = new CascadeStateManager(this.extensionConfig.cascade);
		this.healthScorer = new HealthScorer(this.extensionConfig.health);
		const globalKeyDistributor = getGlobalKeyDistributor();
		this.keyDistributor =
			keyDistributor ??
			globalKeyDistributor ??
			new KeyDistributor(this.storage, this.authWriter);
		registerGlobalKeyDistributor(this.keyDistributor);
		this.keyDistributor.setProviderCapabilitiesResolver((providerId) =>
			this.providerRegistry.getProviderCapabilities(providerId),
		);
		this.keyDistributor.setLightweightRotationState(this.lightweightRotationState);
		this.keyDistributor.setModelEligibilityResolver((providerId, credentialIds, modelId, signal) =>
			this.resolveCredentialModelEligibility(providerId, credentialIds, modelId, undefined, signal),
		);
		this.oauthRefreshScheduler = new OAuthRefreshScheduler(
			async (credentialId, providerId) => this.refreshScheduledOAuthCredential(providerId, credentialId),
			this.extensionConfig.oauthRefresh,
		);
		if (this.runtimeOptions.startOAuthRefreshScheduler) {
			this.oauthRefreshScheduler.start();
		}
	}

	/**
	 * Returns the shared key distributor used for credential balancing.
	 */
	public getKeyDistributor(): KeyDistributor {
		return this.keyDistributor;
	}

	/**
	 * Returns the shared provider registry used for discovery and registration.
	 */
	public getProviderRegistry(): ProviderRegistry {
		return this.providerRegistry;
	}

	private isOAuthRefreshManagedForProvider(provider: SupportedProviderId): boolean {
		return (
			this.extensionConfig.oauthRefresh.enabled &&
			!this.extensionConfig.oauthRefresh.excludedProviders.includes(provider)
		);
	}

	private assertOAuthRefreshManagedForProvider(provider: SupportedProviderId): void {
		if (this.isOAuthRefreshManagedForProvider(provider)) {
			return;
		}
		if (!this.extensionConfig.oauthRefresh.enabled) {
			throw new Error("OAuth token refresh is globally disabled in pi-multi-auth configuration.");
		}
		throw new Error(`OAuth token refresh is explicitly disabled for provider ${provider}.`);
	}

	shutdown(): void {
		this.oauthRefreshScheduler.stop();
		this.lightweightRotationState.shutdown();
	}

	/**
	 * Refreshes extension configuration on reload.
	 * Updates internal config and propagates changes to stateful components.
	 */
	refreshExtensionConfig(config: MultiAuthExtensionConfig): void {
		this.extensionConfig = cloneMultiAuthExtensionConfig(config);
		this.cascadeStateManager.updateConfig(this.extensionConfig.cascade);
		this.healthScorer.updateConfig(this.extensionConfig.health);
		this.oauthRefreshScheduler.updateConfig(this.extensionConfig.oauthRefresh);
	}

	/**
	 * Returns the dynamically discovered list of provider IDs.
	 */
	async getSupportedProviders(): Promise<readonly SupportedProviderId[]> {
		await this.ensureInitialized();
		return this.providerRegistry.discoverProviderIds();
	}

	/**
	 * Returns the normalized credential IDs currently associated with one provider.
	 */
	async listProviderCredentialIds(provider: SupportedProviderId): Promise<readonly string[]> {
		const state = await this.syncProviderState(provider);
		return [...state.credentialIds];
	}

	/**
	 * Returns capability flags for one provider.
	 */
	getProviderCapabilities(provider: SupportedProviderId): ProviderCapabilities {
		return this.providerRegistry.getProviderCapabilities(provider);
	}

	async flushLightweightRotationState(provider?: SupportedProviderId): Promise<void> {
		if (provider) {
			await this.lightweightRotationState.flushProvider(provider);
			return;
		}
		await this.lightweightRotationState.flushAll();
	}

	/**
	 * Returns OAuth providers currently available from the runtime registry.
	 */
	getAvailableOAuthProviders(): readonly AvailableOAuthProvider[] {
		return this.providerRegistry.listAvailableOAuthProviders();
	}

	/**
	 * Returns the multi-auth storage path.
	 */
	getStoragePath(): string {
		return this.storage.getPath();
	}

	private isLightweightRotationProvider(provider: SupportedProviderId): boolean {
		return this.getProviderCapabilities(provider).rotationProfile === "lightweight";
	}

	private applyLightweightRotationState(
		provider: SupportedProviderId,
		state: ProviderRotationState,
	): ProviderRotationState {
		if (!this.isLightweightRotationProvider(provider)) {
			return state;
		}
		return this.lightweightRotationState.applyToProviderState(provider, state);
	}

	private async flushLightweightRotationStateIfNeeded(
		provider: SupportedProviderId,
	): Promise<void> {
		if (!this.isLightweightRotationProvider(provider)) {
			return;
		}
		await this.lightweightRotationState.flushProvider(provider);
	}

	private recordLightweightSelection(
		provider: SupportedProviderId,
		state: ProviderRotationState,
		credentialId: string,
		selectedIndex: number,
		nextActiveIndex: number,
		selectedAt: number,
		poolState?: ProviderPoolState,
		incrementUsage: boolean = true,
	): void {
		if (!this.isLightweightRotationProvider(provider)) {
			return;
		}
		this.lightweightRotationState.recordSelection({
			providerId: provider,
			credentialIds: state.credentialIds,
			credentialId,
			selectedIndex,
			nextActiveIndex,
			selectedAt,
			poolState,
			incrementUsage,
		});
	}

	private recordLightweightTelemetry(provider: SupportedProviderId, credentialIds: readonly string[]): void {
		if (!this.isLightweightRotationProvider(provider)) {
			return;
		}
		this.lightweightRotationState.recordTelemetry({
			providerId: provider,
			credentialIds,
			cascadeState: {
				[provider]: this.cascadeStateManager.getProviderState(provider),
			},
			healthState: this.healthScorer.exportState(credentialIds),
		});
	}

	/**
	 * Returns providers hidden from the /multi-auth modal.
	 */
	async getHiddenProviders(): Promise<SupportedProviderId[]> {
		return this.storage.withLock((state) => ({
			result: [...state.ui.hiddenProviders],
		}));
	}

	/**
	 * Hides or unhides a provider in the /multi-auth modal.
	 */
	async setProviderHidden(provider: SupportedProviderId, hidden: boolean): Promise<boolean> {
		return this.storage.withLock((state) => {
			const currentHidden = new Set(state.ui.hiddenProviders);
			if (hidden) {
				currentHidden.add(provider);
			} else {
				currentHidden.delete(provider);
			}

			state.ui.hiddenProviders = [...currentHidden];
			return {
				result: currentHidden.has(provider),
				next: state,
			};
		});
	}

	/**
	 * Fetches usage/quota snapshot for one credential with provider-specific logic.
	 */
	async getCredentialUsageSnapshot(
		provider: SupportedProviderId,
		credentialId: string,
		options?: UsageFetchOptions,
	): Promise<CredentialUsageSnapshotResult> {
		return this.getCredentialUsageSnapshotWithContext(provider, credentialId, options);
	}

	private createCredentialUsageContext(
		credentialIds: readonly string[],
		selectionCache: CredentialSelectionCache,
		signal?: AbortSignal,
	): CredentialUsageContext {
		return {
			credentialIds,
			selectionCache,
			signal,
		};
	}

	private async getCredentialUsageSnapshotWithContext(
		provider: SupportedProviderId,
		credentialId: string,
		options?: UsageFetchOptions,
		context?: CredentialUsageContext,
	): Promise<CredentialUsageSnapshotResult> {
		const usageRequestCacheKey = getUsageRequestCacheKey(provider, credentialId, options);
		const existingUsageRequest = context?.selectionCache.usageByRequest.get(usageRequestCacheKey);
		if (existingUsageRequest) {
			return existingUsageRequest;
		}

		const usageRequest = this.loadCredentialUsageSnapshot(provider, credentialId, options, context);
		if (!context) {
			return usageRequest;
		}

		context.selectionCache.usageByRequest.set(usageRequestCacheKey, usageRequest);
		return usageRequest;
	}

	private async resolveCredentialForUsage(
		credentialId: string,
		context?: CredentialUsageContext,
	): Promise<StoredAuthCredential | undefined> {
		if (!context) {
			return this.authWriter.getCredential(credentialId);
		}

		context.credentialsByIdPromise ??= this.authWriter.getCredentials(context.credentialIds);
		const credentialsById = await context.credentialsByIdPromise;
		const cachedCredential = credentialsById.get(credentialId);
		if (cachedCredential) {
			return cachedCredential;
		}

		const credential = await this.authWriter.getCredential(credentialId);
		if (credential) {
			credentialsById.set(credentialId, credential);
		}
		return credential;
	}

	private async loadCredentialUsageSnapshot(
		provider: SupportedProviderId,
		credentialId: string,
		options?: UsageFetchOptions,
		context?: CredentialUsageContext,
	): Promise<CredentialUsageSnapshotResult> {
		const cachedUsage = this.usageService.readCachedUsage(provider, credentialId, options);
		if (cachedUsage) {
			return {
				snapshot: cachedUsage.snapshot,
				error: cachedUsage.error,
				fromCache: cachedUsage.fromCache,
			};
		}

		const credential = await raceWithSignal(
			this.resolveCredentialForUsage(credentialId, context),
			context?.signal,
			`Credential usage lookup aborted for ${provider}/${credentialId}.`,
		);
		if (!credential) {
			return {
				snapshot: null,
				error: `Usage unavailable (credential ${credentialId} is missing)`,
				fromCache: false,
			};
		}

		let freshCredential: StoredAuthCredential = credential;
		if (credential.type === "oauth") {
			try {
				freshCredential = await this.refreshIfNeeded(
					provider,
					credentialId,
					credential,
					context?.signal,
				);
			} catch (error: unknown) {
				if (error instanceof Error && error.name === "AbortError") {
					throw error;
				}
				const message = getErrorMessage(error);
				return {
					snapshot: null,
					error: `Usage unavailable (token refresh failed: ${message})`,
					fromCache: false,
				};
			}
		}

		if (context) {
			context.credentialsByIdPromise ??= this.authWriter.getCredentials(context.credentialIds);
			const credentialsById = await context.credentialsByIdPromise;
			credentialsById.set(credentialId, freshCredential);
		}

		const accountId =
			freshCredential.type === "oauth" &&
			typeof freshCredential.accountId === "string" &&
			freshCredential.accountId.trim().length > 0
				? freshCredential.accountId
				: undefined;

		const usage = await raceWithSignal(
			this.usageService.fetchUsage(
				provider,
				credentialId,
				{
					accessToken: getCredentialSecret(freshCredential),
					accountId,
					credential: { ...freshCredential },
				},
				options,
			),
			context?.signal ?? options?.signal,
			`Usage fetch aborted for ${provider}/${credentialId}.`,
		);
		if (!usage.fromCache) {
			await this.reconcileQuotaStateFromUsage(provider, credentialId, usage.snapshot);
		}
		return {
			snapshot: usage.snapshot,
			error: usage.error,
			fromCache: usage.fromCache,
		};
	}

	async recordCredentialSuccess(
		provider: SupportedProviderId,
		credentialId: string,
		latencyMs: number,
	): Promise<void> {
		await this.ensureInitialized();
		this.healthScorer.recordSuccess(credentialId, latencyMs);
		this.healthScorer.endCooldown(credentialId);
		this.healthScorer.calculateScore(credentialId);
		this.cascadeStateManager.clearCascade(provider);
		await this.clearTransientProviderError(provider, credentialId);
		await this.clearQuotaExceeded(provider, credentialId);
		await this.clearActiveFailoverChains();
		await this.persistProviderTelemetry(provider);
	}

	async recordCredentialFailure(
		provider: SupportedProviderId,
		credentialId: string,
		latencyMs: number,
		errorKind: CredentialErrorKind,
		errorMessage: string,
	): Promise<void> {
		await this.ensureInitialized();
		this.healthScorer.recordFailure(credentialId, latencyMs, errorKind);
		this.healthScorer.recordCooldown(credentialId, errorMessage);
		this.healthScorer.calculateScore(credentialId);
		if (this.cascadeStateManager.hasActiveCascade(provider)) {
			this.cascadeStateManager.recordCascadeAttempt(provider, credentialId, errorKind, errorMessage);
		} else {
			this.cascadeStateManager.createCascade(provider, credentialId, errorKind, errorMessage);
		}
		await this.persistProviderTelemetry(provider);
	}

	/**
	 * Sets or clears a friendly display name for a credential.
	 */
	async setFriendlyName(
		provider: SupportedProviderId,
		credentialId: string,
		friendlyName: string,
	): Promise<string> {
		return this.storage.withLock((state) => {
			const providerState = getProviderState(state, provider);
			normalizeProviderState(providerState);
			if (!providerState.credentialIds.includes(credentialId)) {
				throw new Error(`Credential ${credentialId} is not available for provider ${provider}`);
			}

			const normalized = friendlyName.trim();
			if (!normalized || normalized === credentialId) {
				delete providerState.friendlyNames[credentialId];
				return { result: credentialId, next: state };
			}

			providerState.friendlyNames[credentialId] = normalized;
			return { result: normalized, next: state };
		});
	}

	/**
	 * Runs OAuth login for a provider and stores credentials in primary/backup slots.
	 */
	async loginProvider(
		provider: SupportedProviderId,
		callbacks: OAuthLoginCallbacks,
	): Promise<{ credentialId: string; isBackupCredential: boolean; credentialIds: string[] }> {
		const oauthProvider = getOAuthProvider(provider);
		if (!oauthProvider) {
			throw new Error(`OAuth provider is not available: ${provider}`);
		}

		const credentials = await oauthProvider.login(callbacks);
		const duplicateCredentialId = await this.findExistingOAuthCredentialIdByIdentity(
			provider,
			credentials,
		);
		if (duplicateCredentialId) {
			await this.authWriter.setOAuthCredential(duplicateCredentialId, credentials);
			const credentialIds = await this.authWriter.listProviderCredentialIds(provider);
			await this.persistCredentialList(provider, credentialIds, duplicateCredentialId, {
				type: "oauth",
				...credentials,
			});
			this.usageService.clearProvider(provider);
			return {
				credentialId: duplicateCredentialId,
				isBackupCredential: duplicateCredentialId !== provider,
				credentialIds: this.deduplicateCredentialEntries(
					provider,
					await this.authWriter.getProviderCredentialEntries(provider),
				),
			};
		}

		const backupResult = await this.authWriter.setOAuthCredentialAsBackup(provider, credentials);
		await this.persistCredentialList(provider, backupResult.credentialIds, backupResult.credentialId, {
			type: "oauth",
			...credentials,
		});
		this.usageService.clearProvider(provider);

		return backupResult;
	}

	private async findExistingOAuthCredentialIdByIdentity(
		provider: SupportedProviderId,
		credentials: OAuthCredentials,
	): Promise<string | undefined> {
		if (provider !== "cline") {
			return undefined;
		}

		const identityKey = buildClineIdentityKey(credentials);
		if (!identityKey) {
			return undefined;
		}

		const entries = await this.authWriter.getProviderCredentialEntries(provider);
		for (const entry of entries) {
			if (entry.credential.type !== "oauth") {
				continue;
			}
			if (buildClineIdentityKey(entry.credential) === identityKey) {
				return entry.credentialId;
			}
		}
		return undefined;
	}

	/**
	 * Adds an API-key credential in primary/backup slot order.
	 */
	async addApiKeyCredential(
		provider: SupportedProviderId,
		apiKeyInput: string,
	): Promise<BackupAndStoreResult> {
		const validation = validateApiKeyInput(apiKeyInput);
		if (!validation.ok) {
			throw new Error(validation.message);
		}

		const result = await this.authWriter.setApiKeyCredentialAsBackup(provider, validation.value);
		await this.persistCredentialList(provider, result.credentialIds, result.credentialId, {
			type: "api_key",
			key: validation.value,
		});
		this.usageService.clearProvider(provider);
		return result;
	}

	private async persistCredentialList(
		provider: SupportedProviderId,
		credentialIds: string[],
		lastAddedCredentialId: string,
		persistedCredential?: StoredAuthCredential,
	): Promise<void> {
		await this.flushLightweightRotationStateIfNeeded(provider);
		await this.storage.withLock((state) => {
			const providerState = getProviderState(state, provider);
			providerState.credentialIds = [...credentialIds];
			normalizeProviderState(providerState);

			const addedIndex = providerState.credentialIds.indexOf(lastAddedCredentialId);
			if (providerState.credentialIds.length === 1) {
				providerState.activeIndex = 0;
			} else if (addedIndex >= 0 && providerState.manualActiveCredentialId === undefined) {
				providerState.activeIndex = Math.max(0, providerState.activeIndex);
			}

			providerState.lastUsedAt[lastAddedCredentialId] = Date.now();
			return { result: undefined, next: state };
		});

		const credential = persistedCredential ?? (await this.authWriter.getCredential(lastAddedCredentialId));
		if (credential?.type === "oauth") {
			this.scheduleOAuthRefresh(provider, lastAddedCredentialId, credential);
			await this.persistOAuthRefreshSchedule(provider);
		}
	}

	/**
	 * Sets the active credential index for a provider.
	 */
	async switchActiveCredential(provider: SupportedProviderId, index: number): Promise<void> {
		if (!Number.isInteger(index) || index < 0) {
			throw new Error("Credential index must be a non-negative integer");
		}

		await this.flushLightweightRotationStateIfNeeded(provider);

		const syncedState = await this.syncProviderState(provider);
		if (index >= syncedState.credentialIds.length) {
			throw new Error(
				`Index ${index} is out of range for ${provider} (available: ${syncedState.credentialIds.length})`,
			);
		}

		const credentialId = syncedState.credentialIds[index];
		const disabledReason = getDisabledError(syncedState, credentialId);
		if (disabledReason) {
			throw new Error(
				`Cannot activate disabled credential '${credentialId}' for ${provider}. Re-enable it in /multi-auth first. Reason: ${disabledReason.error}`,
			);
		}

		await this.storage.withLock((state) => {
			const providerState = getProviderState(state, provider);
			providerState.activeIndex = index;
			providerState.manualActiveCredentialId = providerState.credentialIds[index];
			providerState.lastUsedAt[providerState.credentialIds[index]] = Date.now();
			return { result: undefined, next: state };
		});
	}

	/**
	 * Clears manual active account selection and returns to extension-managed rotation.
	 */
	async clearManualActiveCredential(provider: SupportedProviderId): Promise<void> {
		await this.flushLightweightRotationStateIfNeeded(provider);
		await this.storage.withLock((state) => {
			const providerState = getProviderState(state, provider);
			providerState.manualActiveCredentialId = undefined;
			return { result: undefined, next: state };
		});
	}

	/**
	 * Deletes one or more credentials from auth.json and syncs provider rotation state.
	 */
	async deleteCredentials(
		provider: SupportedProviderId,
		credentialIds: readonly string[],
	): Promise<void> {
		await this.flushLightweightRotationStateIfNeeded(provider);
		const normalizedCredentialIds = normalizeCredentialIdsForDeletion(credentialIds);
		const state = await this.syncProviderState(provider);
		const availableCredentialIds = new Set(state.credentialIds);
		const missingFromProvider = normalizedCredentialIds.filter(
			(credentialId) => !availableCredentialIds.has(credentialId),
		);
		if (missingFromProvider.length > 0) {
			throw new Error(
				`Credentials ${formatCredentialIdList(missingFromProvider)} are not available for provider ${provider}.`,
			);
		}

		await this.authWriter.withLock((authData) => {
			const missingFromAuth = normalizedCredentialIds.filter(
				(credentialId) => authData[credentialId] === undefined,
			);
			if (missingFromAuth.length > 0) {
				throw new Error(
					`Credentials ${formatCredentialIdList(missingFromAuth)} were not found in auth.json.`,
				);
			}

			const next = { ...authData };
			for (const credentialId of normalizedCredentialIds) {
				delete next[credentialId];
			}
			return { result: undefined, next };
		});

		await this.syncProviderState(provider);
		for (const credentialId of normalizedCredentialIds) {
			this.cascadeStateManager.removeCredential(provider, credentialId);
			this.healthScorer.removeCredential(credentialId);
			this.oauthRefreshScheduler.cancelRefresh(credentialId);
			this.usageService.clearCredential(provider, credentialId);
		}
		await this.persistProviderTelemetry(provider);
		await this.persistOAuthRefreshSchedule(provider);
	}

	/**
	 * Deletes a credential from auth.json and syncs provider rotation state.
	 */
	async deleteCredential(provider: SupportedProviderId, credentialId: string): Promise<void> {
		await this.deleteCredentials(provider, [credentialId]);
	}

	private async disableCredential(
		provider: SupportedProviderId,
		credentialId: string,
		rawErrorMessage: string,
		errorKind: CredentialErrorKind,
	): Promise<void> {
		await this.ensureInitialized();

		const errorMessage = rawErrorMessage.trim();
		if (!errorMessage) {
			throw new Error("Cannot disable credential without a non-empty error message.");
		}

		const didDisable = await this.storage.withLock((stored) => {
			const providerState = getProviderState(stored, provider);
			if (!providerState.credentialIds.includes(credentialId)) {
				return { result: false };
			}

			if (!providerState.disabledCredentials) {
				providerState.disabledCredentials = {};
			}

			providerState.disabledCredentials[credentialId] = {
				error: errorMessage,
				disabledAt: Date.now(),
			};

			if (providerState.manualActiveCredentialId === credentialId) {
				providerState.manualActiveCredentialId = undefined;
			}

			return { result: true, next: stored };
		});
		if (!didDisable) {
			throw new Error(`Credential ${credentialId} is not available for provider ${provider}`);
		}

		await this.recordCredentialFailure(provider, credentialId, 0, errorKind, errorMessage);
		this.oauthRefreshScheduler.cancelRefresh(credentialId);
		await this.persistOAuthRefreshSchedule(provider);
		this.usageService.clearCredential(provider, credentialId);
	}

	private createOAuthRefreshFailure(
		provider: SupportedProviderId,
		credentialId: string,
		error: unknown,
	): OAuthRefreshFailureError {
		if (isOAuthRefreshFailureError(error)) {
			const summary = formatOAuthRefreshFailureSummary({
				providerLabel: formatOAuthProviderLabel(error.details.providerId || provider),
				status: error.details.status,
				errorCode: error.details.errorCode,
				reason: error.details.reason,
				permanent: error.details.permanent,
				source: error.details.source,
			});
			return new OAuthRefreshFailureError(
				`Failed to refresh OAuth token for ${credentialId}: ${summary}`,
				{
					...error.details,
					credentialId,
				},
				{ cause: error },
			);
		}

		const inferredMetadata = inferOAuthRefreshFailureMetadata(getErrorMessage(error));
		const summary = formatOAuthRefreshFailureSummary({
			providerLabel: formatOAuthProviderLabel(provider),
			errorCode: inferredMetadata.errorCode,
			reason: inferredMetadata.reason,
			permanent: inferredMetadata.permanent,
			source: "provider",
		});
		return new OAuthRefreshFailureError(
			`Failed to refresh OAuth token for ${credentialId}: ${summary}`,
			{
				providerId: provider,
				credentialId,
				errorCode: inferredMetadata.errorCode,
				reason: inferredMetadata.reason,
				permanent: inferredMetadata.permanent ?? false,
				source: "provider",
			},
			{ cause: error },
		);
	}

	private async clearRecoveredOAuthRefreshFailureState(
		provider: SupportedProviderId,
		credentialId: string,
		credential: StoredOAuthCredential,
	): Promise<void> {
		if (provider !== "openai-codex" && provider !== "cline") {
			return;
		}

		await this.storage.withLock((state) => {
			const providerState = getProviderState(state, provider);
			if (!providerState.credentialIds.includes(credentialId)) {
				return { result: false };
			}

			const changed = clearRecoveredOAuthRefreshFailureStateForCredential(
				provider,
				providerState,
				credentialId,
				credential,
			);
			if (!changed) {
				return { result: false };
			}

			normalizeProviderState(providerState);
			return { result: true, next: state };
		});
	}

	private async tryRecoverConcurrentCodexRefresh(
		provider: SupportedProviderId,
		credentialId: string,
		credential: StoredOAuthCredential,
		error: unknown,
	): Promise<StoredOAuthCredential | null> {
		if (provider !== "openai-codex" || !isOAuthRefreshFailureError(error)) {
			return null;
		}

		const isRefreshTokenReuseFailure =
			error.details.errorCode === "refresh_token_reused" ||
			/already been used to generate a new access token/i.test(error.message);
		if (!isRefreshTokenReuseFailure) {
			return null;
		}

		const currentCredential = await this.authWriter.getCredential(credentialId);
		if (!currentCredential || currentCredential.type !== "oauth") {
			return null;
		}

		const hasRotatedRefreshToken = currentCredential.refresh !== credential.refresh;
		const hasRotatedAccessToken = currentCredential.access !== credential.access;
		const hasNewerExpiry = currentCredential.expires > credential.expires;
		if (!hasRotatedRefreshToken && !hasRotatedAccessToken && !hasNewerExpiry) {
			return null;
		}

		await this.clearRecoveredOAuthRefreshFailureState(provider, credentialId, currentCredential);
		multiAuthDebugLogger.log("oauth_refresh_reuse_recovered", {
			provider,
			credentialId,
			errorCode: error.details.errorCode,
			hasRotatedRefreshToken,
			hasRotatedAccessToken,
			hasNewerExpiry,
		});
		return currentCredential;
	}

	private async logAndHandleOAuthRefreshFailure(
		provider: SupportedProviderId,
		credentialId: string,
		credential: StoredOAuthCredential,
		error: unknown,
	): Promise<OAuthRefreshFailureError> {
		const failure = this.createOAuthRefreshFailure(provider, credentialId, error);
		multiAuthDebugLogger.log("oauth_refresh_failed", {
			provider,
			credentialId,
			message: failure.message,
			permanent: failure.details.permanent,
			source: failure.details.source,
			status: failure.details.status,
			errorCode: failure.details.errorCode,
			reason: failure.details.reason,
		});

		if (failure.details.errorCode === UNSUPPORTED_OAUTH_REFRESH_PROVIDER_ERROR_CODE) {
			this.oauthRefreshScheduler.cancelRefresh(credentialId);
			await this.persistOAuthRefreshSchedule(provider);
			multiAuthDebugLogger.log("oauth_refresh_provider_unavailable", {
				provider,
				credentialId,
				message: failure.message,
				errorCode: failure.details.errorCode,
				source: failure.details.source,
			});
			return failure;
		}

		if (failure.details.permanent) {
			const now = Date.now();
			if (
				shouldPreserveActiveOAuthCredentialAfterRefreshFailure(
					provider,
					credential,
					failure,
					now,
				)
			) {
				await this.clearRecoveredOAuthRefreshFailureState(provider, credentialId, credential);
				this.oauthRefreshScheduler.cancelRefresh(credentialId);
				await this.persistOAuthRefreshSchedule(provider);
				multiAuthDebugLogger.log("oauth_refresh_active_token_preserved", {
					provider,
					credentialId,
					message: failure.message,
					status: failure.details.status,
					errorCode: failure.details.errorCode,
					reason: failure.details.reason,
					expiresAt: credential.expires,
					remainingMs: Math.max(0, credential.expires - now),
				});
				return failure;
			}

			// For OpenAI Codex, we don't auto-disable credentials on OAuth refresh failures.
			// Instead, we set a long cooldown (24 hours) so the user can manually re-login
			// and refresh the token without losing the credential configuration.
			// This is less aggressive and allows users to recover without re-adding accounts.
			if (provider === "openai-codex") {
				await this.markQuotaExceeded(provider, credentialId, {
					errorMessage: failure.message,
					isWeekly: false,
					recommendedCooldownMs: OAUTH_REFRESH_FAILURE_COOLDOWN_MS,
				});
				// Cancel the OAuth refresh schedule since the token is permanently invalid
				this.oauthRefreshScheduler.cancelRefresh(credentialId);
				await this.persistOAuthRefreshSchedule(provider);
				multiAuthDebugLogger.log("oauth_refresh_codex_cooldown", {
					provider,
					credentialId,
					message: failure.message,
					cooldownMs: OAUTH_REFRESH_FAILURE_COOLDOWN_MS,
					status: failure.details.status,
					errorCode: failure.details.errorCode,
				});
			} else {
				await this.disableCredential(provider, credentialId, failure.message, "authentication");
				multiAuthDebugLogger.log("oauth_refresh_permanently_disabled", {
					provider,
					credentialId,
					message: failure.message,
					status: failure.details.status,
					errorCode: failure.details.errorCode,
				});
			}
		}

		return failure;
	}

	/**
	 * Marks a credential as disabled in multi-auth.json (not auth.json).
	 * Disabled credentials are excluded from rotation until manually re-enabled.
	 */
	async disableApiKeyCredential(
		provider: SupportedProviderId,
		credentialId: string,
		rawErrorMessage: string,
	): Promise<void> {
		await this.disableCredential(provider, credentialId, rawErrorMessage, "balance_exhausted");
	}

	/**
	 * Re-enables a previously disabled credential, allowing it to participate in rotation again.
	 * Clears the disabled state from multi-auth.json and reschedules OAuth refresh if applicable.
	 */
	async reenableCredential(
		provider: SupportedProviderId,
		credentialId: string,
	): Promise<void> {
		await this.ensureInitialized();

		const didReenable = await this.storage.withLock((stored) => {
			const providerState = getProviderState(stored, provider);
			if (!providerState.credentialIds.includes(credentialId)) {
				return { result: false };
			}

			if (!providerState.disabledCredentials?.[credentialId]) {
				return { result: false };
			}

			delete providerState.disabledCredentials[credentialId];

			if (Object.keys(providerState.disabledCredentials).length === 0) {
				providerState.disabledCredentials = {};
			}

			return { result: true, next: stored };
		});

		if (!didReenable) {
			throw new Error(
				`Credential ${credentialId} is not available or not disabled for provider ${provider}`,
			);
		}

		const credentialsById = await this.authWriter.getCredentials([credentialId]);
		const credential = credentialsById.get(credentialId);
		if (credential?.type === "oauth") {
			const refreshResult = await this.refreshCredential(provider, credentialId);
			if (refreshResult.disposition === "refreshed") {
				this.scheduleOAuthRefresh(provider, credentialId, refreshResult.credential);
				await this.persistOAuthRefreshSchedule(provider);
			}
		}

		this.usageService.clearCredential(provider, credentialId);
	}

	/**
	 * Refreshes a specific OAuth credential token and persists it back to auth.json.
	 */
	async refreshCredential(
		provider: SupportedProviderId,
		credentialId: string,
	): Promise<CredentialRefreshResult> {
		const state = await this.syncProviderState(provider);
		if (!state.credentialIds.includes(credentialId)) {
			throw new Error(`Credential ${credentialId} is not available for provider ${provider}`);
		}

		const credential = await this.authWriter.getCredential(credentialId);
		if (!credential) {
			throw new Error(`Credential ${credentialId} was not found in auth.json`);
		}
		if (credential.type !== "oauth") {
			throw new Error(
				`Credential ${credentialId} is an API key and does not support OAuth token refresh.`,
			);
		}
		this.assertOAuthRefreshManagedForProvider(provider);

		let effectiveCredential: StoredOAuthCredential;
		let disposition: CredentialRefreshDisposition = "refreshed";
		let shouldPersistRefreshSchedule = true;
		try {
			effectiveCredential = await this.refreshCredentialToken(provider, credentialId, credential);
			this.scheduleOAuthRefresh(provider, credentialId, effectiveCredential);
		} catch (error) {
			if (
				isOAuthRefreshFailureError(error) &&
				shouldPreserveActiveOAuthCredentialAfterRefreshFailure(provider, credential, error)
			) {
				effectiveCredential = credential;
				disposition = "preserved_active_token";
				shouldPersistRefreshSchedule = false;
			} else {
				throw error;
			}
		}
		await this.storage.withLock((stored) => {
			const providerState = getProviderState(stored, provider);
			providerState.lastUsedAt[credentialId] = Date.now();
			return { result: undefined, next: stored };
		});
		if (shouldPersistRefreshSchedule) {
			await this.persistOAuthRefreshSchedule(provider);
		}
		this.usageService.clearCredential(provider, credentialId);

		return {
			credential: effectiveCredential,
			disposition,
		};
	}

	/**
	 * Refreshes all credentials for a provider and reconciles persisted quota state from fresh usage data.
	 */
	async refreshProviderCredentials(
		provider: SupportedProviderId,
	): Promise<ProviderRefreshResult> {
		const state = await this.syncProviderState(provider);
		const totalCredentials = state.credentialIds.length;
		const refreshedCredentialIds: string[] = [];
		const preservedCredentialIds: string[] = [];
		const failedCredentials: Array<{ credentialId: string; error: string }> = [];
		const usageWarnings: Array<{ credentialId: string; warning: string }> = [];
		const credentialsById = await this.authWriter.getCredentials(state.credentialIds);

		for (const credentialId of state.credentialIds) {
			const credential = credentialsById.get(credentialId);
			if (!credential) {
				failedCredentials.push({
					credentialId,
					error: `Credential ${credentialId} is missing from auth.json`,
				});
				continue;
			}

			if (credential.type === "oauth") {
				try {
					const refreshResult = await this.refreshCredential(provider, credentialId);
					if (refreshResult.disposition === "preserved_active_token") {
						preservedCredentialIds.push(credentialId);
					} else {
						refreshedCredentialIds.push(credentialId);
					}
				} catch (error: unknown) {
					const message = getErrorMessage(error);
					failedCredentials.push({ credentialId, error: message });
					continue;
				}
			} else {
				refreshedCredentialIds.push(credentialId);
			}

			try {
				const usage = await this.getCredentialUsageSnapshot(provider, credentialId, {
					forceRefresh: true,
				});
				if (usage.error) {
					usageWarnings.push({ credentialId, warning: usage.error });
				}
			} catch (error: unknown) {
				const message = getErrorMessage(error);
				usageWarnings.push({
					credentialId,
					warning: `Usage reconciliation failed (${message})`,
				});
			}
		}

		return {
			provider,
			totalCredentials,
			refreshedCredentialIds,
			preservedCredentialIds,
			failedCredentials,
			usageWarnings,
		};
	}

	async resolveFailoverTarget(
		provider: SupportedProviderId,
		errorKind: CredentialErrorKind,
		modelId: string,
	): Promise<ResolvedFailoverTarget | null> {
		return this.storage.withLock(async (state) => {
			const chainDefinitions = this.collectFailoverChains(state, provider);
			if (chainDefinitions.length === 0) {
				return { result: null };
			}

			const manager = new FailoverChainManager(chainDefinitions);
			const activeState = this.getActiveFailoverState(state, chainDefinitions);
			manager.loadState(activeState);
			if (!manager.shouldFailover(errorKind)) {
				return { result: null };
			}

			const next = manager.getNextInChain(provider, errorKind, modelId);
			if (!next) {
				this.clearFailoverStateFromState(state, chainDefinitions);
				return { result: null, next: state };
			}

			const metadata = await this.providerRegistry.resolveProviderRegistrationMetadata(next.providerId);
			if (!metadata) {
				return {
					result: null,
					next: state,
				};
			}

			const resolvedModel = metadata.models.find((candidate) => candidate.id === next.modelId);
			if (!resolvedModel) {
				return {
					result: null,
					next: state,
				};
			}

			const exportedState = manager.exportState();
			this.persistFailoverStateToProviders(state, chainDefinitions, exportedState);
			return {
				result: {
					...next,
					api: resolvedModel.api ?? metadata.api,
				},
				next: state,
			};
		});
	}

	private collectFailoverChains(
		state: MultiAuthState,
		provider: SupportedProviderId,
	): FailoverChain[] {
		const deduped = new Map<string, FailoverChain>();
		for (const providerState of Object.values(state.providers)) {
			for (const chain of providerState.chains ?? []) {
				if (!chain.providers.some((entry) => entry.providerId === provider)) {
					continue;
				}
				if (!deduped.has(chain.chainId)) {
					deduped.set(chain.chainId, JSON.parse(JSON.stringify(chain)) as FailoverChain);
				}
			}
		}
		return [...deduped.values()];
	}

	private getActiveFailoverState(
		state: MultiAuthState,
		chains: readonly FailoverChain[],
	): FailoverChainState | undefined {
		const chainIds = new Set(chains.map((chain) => chain.chainId));
		for (const providerState of Object.values(state.providers)) {
			if (providerState.activeChain && chainIds.has(providerState.activeChain.chainId)) {
				return JSON.parse(JSON.stringify(providerState.activeChain)) as FailoverChainState;
			}
		}
		return undefined;
	}

	private persistFailoverStateToProviders(
		state: MultiAuthState,
		chains: readonly FailoverChain[],
		activeState: FailoverChainState | undefined,
	): void {
		const providerIds = new Set<string>();
		for (const chain of chains) {
			for (const provider of chain.providers) {
				providerIds.add(provider.providerId);
			}
		}
		for (const providerId of providerIds) {
			const providerState = getProviderState(state, providerId);
			providerState.activeChain = activeState
				? JSON.parse(JSON.stringify(activeState)) as FailoverChainState
				: undefined;
		}
	}

	private clearFailoverStateFromState(
		state: MultiAuthState,
		chains?: readonly FailoverChain[],
	): void {
		if (chains && chains.length > 0) {
			this.persistFailoverStateToProviders(state, chains, undefined);
			return;
		}

		for (const providerState of Object.values(state.providers)) {
			providerState.activeChain = undefined;
		}
	}

	private async clearActiveFailoverChains(): Promise<void> {
		await this.storage.withLock((state) => {
			const hadActiveChain = Object.values(state.providers).some(
				(providerState) => providerState.activeChain !== undefined,
			);
			if (!hadActiveChain) {
				return { result: undefined };
			}
			this.clearFailoverStateFromState(state);
			return { result: undefined, next: state };
		});
	}

	private async selectPooledCredential(
		provider: SupportedProviderId,
		state: ProviderRotationState,
		available: Set<string>,
		healthScores: ProviderRotationState["healthState"],
		usageContext?: CredentialUsageContext,
		signal?: AbortSignal,
	): Promise<{ selectedIndex: number; poolMode: RotationMode; poolState: ProviderPoolState } | null> {
		throwIfAborted(signal, `Pooled credential selection aborted for ${provider}.`);
		if (!state.pools || state.pools.length === 0) {
			return null;
		}

		const poolConfig = resolveProviderPoolConfig(state);
		const poolManager = new PoolManager({
			enablePools: poolConfig.enablePools,
			pools: state.pools,
			failoverStrategy: poolConfig.failoverStrategy,
			preferHealthyWithinPool: poolConfig.preferHealthyWithinPool,
		});
		const selection = poolManager.selectPool([...available], {
			scores: healthScores?.scores,
			state: state.poolState,
		});
		if (!selection) {
			return null;
		}

		const poolAvailable = new Set(selection.availableCredentialIds);
		let selectedIndex: number | undefined;
		switch (selection.pool.poolMode) {
			case "usage-based":
				selectedIndex = await this.getUsageBasedCandidateIndex(
					provider,
					state,
					poolAvailable,
					usageContext,
				);
				break;
			case "balancer": {
				const selectedCredentialId = await this.keyDistributor.acquireKey(
					{
						providerId: provider,
						excludedIds: state.credentialIds.filter(
							(credentialId) => !poolAvailable.has(credentialId),
						),
						requestingSessionId: `orchestrator:${provider}:pool:${selection.pool.poolId}`,
					},
					{ signal },
				);
				selectedIndex = state.credentialIds.indexOf(selectedCredentialId);
				break;
			}
			case "round-robin":
			default:
				selectedIndex = getRoundRobinCandidateIndex(state, poolAvailable);
				break;
		}
		if (selectedIndex === undefined || selectedIndex < 0) {
			return null;
		}

		return {
			selectedIndex,
			poolMode: selection.pool.poolMode,
			poolState: selection.poolState,
		};
	}

	private buildQuotaState(
		credentialId: string,
		errorMessage: string,
		classification: QuotaClassificationResult,
	): QuotaStateForCredential {
		return quotaClassifier.createQuotaState(credentialId, errorMessage, classification);
	}

	/**
	 * Selects a credential for request execution and refreshes token if needed.
	 */
	async acquireCredential(
		provider: SupportedProviderId,
		options?: AcquireCredentialOptions,
	): Promise<SelectedCredential> {
		throwIfAborted(options?.signal, `Credential acquisition aborted for ${provider}.`);
		let state = await raceWithSignal(
			this.syncProviderState(provider),
			options?.signal,
			`Credential acquisition aborted for ${provider}.`,
		);
		if (state.credentialIds.length === 0) {
			throw new Error(`No credentials available for ${provider}. Open /multi-auth and add an account.`);
		}

		let disabledCredentialIds = await this.getDisabledCredentialIds(state);
		if (
			state.manualActiveCredentialId &&
			disabledCredentialIds.has(state.manualActiveCredentialId)
		) {
			await this.clearManualActiveCredential(provider);
			state = await raceWithSignal(
				this.syncProviderState(provider),
				options?.signal,
				`Credential acquisition aborted for ${provider}.`,
			);
			disabledCredentialIds = await this.getDisabledCredentialIds(state);
		}

		const expiredApiKeyCredentialIds = new Set<string>();
		if (provider === "cline") {
			const credentialSnapshot = await raceWithSignal(
				this.authWriter.getCredentials(state.credentialIds),
				options?.signal,
				`Credential acquisition aborted for ${provider}.`,
			);
			const expirationCheckTimestamp = Date.now();
			for (const credentialId of state.credentialIds) {
				const credential = credentialSnapshot.get(credentialId);
				if (credential && isExpiredApiKeyCredential(provider, credential, expirationCheckTimestamp)) {
					expiredApiKeyCredentialIds.add(credentialId);
				}
			}
		}

		const effectiveExcludedCredentialIds = new Set(options?.excludedCredentialIds ?? []);
		for (const disabledCredentialId of disabledCredentialIds) {
			effectiveExcludedCredentialIds.add(disabledCredentialId);
		}
		for (const blockedCredentialId of this.cascadeStateManager.getBlockedCredentialIds(provider)) {
			effectiveExcludedCredentialIds.add(blockedCredentialId);
		}
		for (const expiredCredentialId of expiredApiKeyCredentialIds) {
			effectiveExcludedCredentialIds.add(expiredCredentialId);
		}

		const selectionCache = options?.selectionCache ?? createCredentialSelectionCache();
		const usageContext = this.createCredentialUsageContext(
			state.credentialIds,
			selectionCache,
			options?.signal,
		);
		const requestedModelId = normalizeModelId(options?.modelId) ?? undefined;
		const modelEligibility = await this.resolveCredentialModelEligibility(
			provider,
			state.credentialIds,
			requestedModelId,
			usageContext,
		);

		for (const ineligibleCredentialId of modelEligibility.ineligibleCredentialIds) {
			effectiveExcludedCredentialIds.add(ineligibleCredentialId);
		}

		if (
			modelEligibility.appliesConstraint &&
			modelEligibility.eligibleCredentialIds.length === 0
		) {
			throw new Error(modelEligibility.failureMessage);
		}

		if (effectiveExcludedCredentialIds.size >= state.credentialIds.length) {
			if (expiredApiKeyCredentialIds.size === state.credentialIds.length) {
				throw new Error(
					`All credentials for ${provider} are expired WorkOS session tokens. Re-authenticate the account in /multi-auth.`,
				);
			}
			throw new Error(
				`All credentials for ${provider} are unavailable (disabled, expired, or temporarily exhausted). Add another account in /multi-auth.`,
			);
		}

		const manualCredentialId = state.manualActiveCredentialId;
		let selectedIndex: number | undefined;
		let selectedRotationMode: RotationMode | undefined;
		let selectedPoolState: ProviderPoolState | undefined;
		if (manualCredentialId) {
			if (
				modelEligibility.appliesConstraint &&
				modelEligibility.ineligibleCredentialIds.includes(manualCredentialId) &&
				requestedModelId !== undefined
			) {
				throw new Error(
					`Manual active account '${manualCredentialId}' for ${provider} is not eligible for ${formatModelReference(provider, requestedModelId)}. Clear manual active selection in /multi-auth to let automatic rotation use an entitled account.`,
				);
			}
			if (effectiveExcludedCredentialIds.has(manualCredentialId)) {
				if (expiredApiKeyCredentialIds.has(manualCredentialId)) {
					throw new Error(
						`Manual active account '${manualCredentialId}' for ${provider} uses an expired WorkOS token. Re-authenticate the account or clear manual active selection in /multi-auth to let automatic rotation recover.`,
					);
				}
				const disabledReason = getDisabledError(state, manualCredentialId);
				if (disabledReason) {
					throw new Error(
						`Manual active account '${manualCredentialId}' for ${provider} is disabled due to a previous provider error. Clear manual active selection in /multi-auth to let automatic rotation recover.`,
					);
				}
				throw new Error(
					`Manual active account '${manualCredentialId}' for ${provider} is quota-limited for this request. Disable manual active selection in /multi-auth to let automatic rotation recover.`,
				);
			}

			selectedIndex = state.credentialIds.indexOf(manualCredentialId);
			if (selectedIndex < 0) {
				await this.clearManualActiveCredential(provider);
				state = await raceWithSignal(
					this.syncProviderState(provider),
					options?.signal,
					`Credential acquisition aborted for ${provider}.`,
				);
				selectedIndex = undefined;
			} else {
				const exhaustedUntil = state.quotaExhaustedUntil[manualCredentialId];
				if (typeof exhaustedUntil === "number" && exhaustedUntil > Date.now()) {
					throw new Error(
						`Manual active account '${manualCredentialId}' for ${provider} is marked exhausted until ${new Date(exhaustedUntil).toISOString()}. Clear manual active selection in /multi-auth to let automatic rotation use other accounts.`,
					);
				}
			}
		}

		if (selectedIndex === undefined) {
			let now = Date.now();
			let available = buildAvailableSet(state, now, effectiveExcludedCredentialIds);
			if (available.size === 0) {
				await this.reconcileBlockedCredentialsFromUsage(
					provider,
					state,
					effectiveExcludedCredentialIds,
					usageContext,
				);
				state = await raceWithSignal(
					this.syncProviderState(provider),
					options?.signal,
					`Credential acquisition aborted for ${provider}.`,
				);
				now = Date.now();
				available = buildAvailableSet(state, now, effectiveExcludedCredentialIds);
			}

			if (available.size === 0) {
				const recoveredState = await this.releaseOneCooldownLockForProviderWithoutUsage(
					provider,
					state,
					effectiveExcludedCredentialIds,
				);
				if (recoveredState) {
					state = recoveredState;
					now = Date.now();
					available = buildAvailableSet(state, now, effectiveExcludedCredentialIds);
				}
			}

			if (available.size === 0) {
				throw new Error(
					`All credentials for ${provider} are unavailable (disabled or temporarily exhausted). Add another account in /multi-auth.`,
				);
			}

			const pooledSelection = await this.selectPooledCredential(
				provider,
				state,
				available,
				state.healthState,
				usageContext,
				options?.signal,
			);
			if (pooledSelection) {
				selectedIndex = pooledSelection.selectedIndex;
				selectedRotationMode = pooledSelection.poolMode;
				selectedPoolState = pooledSelection.poolState;
			} else if (state.rotationMode === "balancer") {
				const selectedCredentialId = await this.keyDistributor.acquireKey(
					{
						providerId: provider,
						excludedIds: [...effectiveExcludedCredentialIds],
						requestingSessionId: `orchestrator:${provider}`,
					},
					{ signal: options?.signal },
				);
				selectedIndex = state.credentialIds.indexOf(selectedCredentialId);
				if (selectedIndex < 0) {
					state = await raceWithSignal(
						this.syncProviderState(provider),
						options?.signal,
						`Credential acquisition aborted for ${provider}.`,
					);
					selectedIndex = state.credentialIds.indexOf(selectedCredentialId);
				}
			} else {
				selectedIndex =
					state.rotationMode === "usage-based"
						? await this.getUsageBasedCandidateIndex(provider, state, available, usageContext)
						: getRoundRobinCandidateIndex(state, available);
			}
		}

		if (selectedIndex === undefined) {
			throw new Error(`Could not find an available credential for ${provider}`);
		}

		const credentialId = state.credentialIds[selectedIndex];
		const credential = await raceWithSignal(
			this.authWriter.getCredential(credentialId),
			options?.signal,
			`Credential acquisition aborted for ${provider}.`,
		);
		if (!credential) {
			await raceWithSignal(
				this.syncProviderState(provider),
				options?.signal,
				`Credential acquisition aborted for ${provider}.`,
			);
			throw new Error(
				`Credential ${credentialId} is missing from auth.json. Open /multi-auth and add the account again if needed.`,
			);
		}

		const disabledReason = getDisabledError(state, credentialId);
		if (disabledReason) {
			const nextExcludedCredentialIds = new Set(effectiveExcludedCredentialIds);
			nextExcludedCredentialIds.add(credentialId);
			return this.acquireCredential(provider, {
				excludedCredentialIds: nextExcludedCredentialIds,
				modelId: options?.modelId,
				selectionCache,
				signal: options?.signal,
			});
		}

		const freshCredential =
			credential.type === "oauth"
				? await this.refreshIfNeeded(provider, credentialId, credential, options?.signal)
				: credential;
		const effectiveRotationMode = selectedRotationMode ?? state.rotationMode;
		throwIfAborted(options?.signal, `Credential acquisition aborted for ${provider}.`);

		const selectedAt = Date.now();
		const hasSelectionExclusions = effectiveExcludedCredentialIds.size > 0;
		const nextRoundRobinIndex =
			state.credentialIds.length > 0 ? (selectedIndex + 1) % state.credentialIds.length : selectedIndex;
		const nextActiveIndex = state.manualActiveCredentialId
			? selectedIndex
			: effectiveRotationMode === "round-robin"
				? hasSelectionExclusions
					? selectedIndex
					: nextRoundRobinIndex
				: selectedIndex;
		if (this.isLightweightRotationProvider(provider)) {
			this.recordLightweightSelection(
				provider,
				state,
				credentialId,
				selectedIndex,
				nextActiveIndex,
				selectedAt,
				selectedPoolState,
			);
			if (selectedPoolState) {
				await this.flushLightweightRotationStateIfNeeded(provider);
			}
		} else {
			await this.storage.withLock((stored) => {
				const providerState = getProviderState(stored, provider);
				providerState.activeIndex = nextActiveIndex;
				providerState.usageCount[credentialId] = (providerState.usageCount[credentialId] ?? 0) + 1;
				providerState.lastUsedAt[credentialId] = selectedAt;
				if (selectedPoolState) {
					providerState.poolState = { ...selectedPoolState };
				}
				return { result: undefined, next: stored };
			});
		}

		return {
			provider,
			credentialId,
			credential: freshCredential,
			secret: getCredentialRequestSecret(provider, freshCredential),
			index: selectedIndex,
		};
	}

	/**
	 * Marks a credential as quota exhausted so it is skipped by the selector for a cooldown period.
	 * Rich quota classification is persisted additively for UI and recovery decisions.
	 */
	async markQuotaExceeded(
		provider: SupportedProviderId,
		credentialId: string,
		options?: {
			errorMessage?: string;
			isWeekly?: boolean;
			quotaClassification?: QuotaClassification;
			recommendedCooldownMs?: number;
		},
	): Promise<void> {
		const { errorMessage, isWeekly, quotaClassification, recommendedCooldownMs } = options ?? {};
		const normalizedMessage =
			errorMessage?.trim() || (isWeekly ? "Weekly quota exhausted" : "Quota exhausted");
		const classifiedQuota = quotaClassification
			? {
				classification: quotaClassification,
				cooldownMs:
					typeof recommendedCooldownMs === "number" && Number.isFinite(recommendedCooldownMs)
						? recommendedCooldownMs
						: quotaClassifier.classifyFromMessage(normalizedMessage).cooldownMs,
				recoveryAction: quotaClassifier.getRecoveryAction(quotaClassification),
				confidence: "high" as const,
				source: "message" as const,
			} satisfies QuotaClassificationResult
			: quotaClassifier.classifyFromMessage(normalizedMessage);
		const weeklyQuota = isWeekly || classifiedQuota.classification === "weekly";
		await this.recordCredentialFailure(
			provider,
			credentialId,
			0,
			weeklyQuota ? "quota_weekly" : "quota",
			normalizedMessage,
		);

		let cooldownMs =
			typeof classifiedQuota.cooldownMs === "number" && Number.isFinite(classifiedQuota.cooldownMs)
				? classifiedQuota.cooldownMs
				: QUOTA_COOLDOWN_MS;
		const quotaState = this.buildQuotaState(credentialId, normalizedMessage, classifiedQuota);

		const shouldApplyBalancerCooldown = await this.storage.withLock((state) => {
			const providerState = getProviderState(state, provider);
			if (!providerState.credentialIds.includes(credentialId)) {
				return { result: false };
			}

			const now = Date.now();
			providerState.lastQuotaError = providerState.lastQuotaError ?? {};
			providerState.lastQuotaError[credentialId] = normalizedMessage.slice(0, 500);
			providerState.quotaStates = providerState.quotaStates ?? {};
			providerState.quotaStates[credentialId] = quotaState;

			if (weeklyQuota) {
				providerState.weeklyQuotaAttempts = providerState.weeklyQuotaAttempts ?? {};
				const attempts = (providerState.weeklyQuotaAttempts[credentialId] ?? 0) + 1;
				providerState.weeklyQuotaAttempts[credentialId] = attempts;
				cooldownMs = Math.max(cooldownMs, getWeeklyQuotaCooldownMs(attempts));
			} else if (providerState.weeklyQuotaAttempts?.[credentialId] !== undefined) {
				delete providerState.weeklyQuotaAttempts[credentialId];
			}

			const currentUntil = providerState.quotaExhaustedUntil[credentialId] ?? 0;
			const nextUntil = Math.max(currentUntil, now + cooldownMs);
			providerState.quotaExhaustedUntil[credentialId] = nextUntil;
			providerState.quotaStates[credentialId] = {
				...providerState.quotaStates[credentialId],
				resetAt: nextUntil,
			};
			providerState.quotaErrorCount[credentialId] =
				(providerState.quotaErrorCount[credentialId] ?? 0) + 1;

			return {
				result: providerState.rotationMode === "balancer",
				next: state,
			};
		});

		if (shouldApplyBalancerCooldown) {
			await this.keyDistributor.applyCooldown(
				credentialId,
				cooldownMs,
				weeklyQuota ? "weekly-quota-exhausted" : `quota-${classifiedQuota.classification}`,
				provider,
				weeklyQuota,
				normalizedMessage,
			);
		}

		this.usageService.clearCredential(provider, credentialId);
	}

	/**
	 * Marks a credential as transiently unhealthy so repeated provider/transport failures
	 * back off exponentially instead of hammering the same key immediately.
	 */
	async markTransientProviderError(
		provider: SupportedProviderId,
		credentialId: string,
		errorMessage: string,
	): Promise<number> {
		const message = errorMessage.trim().slice(0, 500) || "Transient provider error";
		await this.recordCredentialFailure(provider, credentialId, 0, "provider_transient", message);
		let cooldownMs = TRANSIENT_COOLDOWN_BASE_MS;

		const shouldApplyBalancerCooldown = await this.storage.withLock((state) => {
			const providerState = getProviderState(state, provider);
			if (!providerState.credentialIds.includes(credentialId)) {
				return { result: false };
			}

			const now = Date.now();
			const attempts = (providerState.transientErrorCount[credentialId] ?? 0) + 1;
			providerState.transientErrorCount[credentialId] = attempts;
			providerState.lastTransientError = providerState.lastTransientError ?? {};
			providerState.lastTransientError[credentialId] = message;
			cooldownMs = computeExponentialBackoffMs(
				TRANSIENT_COOLDOWN_BASE_MS,
				attempts,
				TRANSIENT_COOLDOWN_MAX_MS,
			);

			const currentUntil = providerState.quotaExhaustedUntil[credentialId] ?? 0;
			providerState.quotaExhaustedUntil[credentialId] = Math.max(
				currentUntil,
				now + cooldownMs,
			);

			return {
				result: providerState.rotationMode === "balancer",
				next: state,
			};
		});

		if (shouldApplyBalancerCooldown) {
			await this.keyDistributor.applyCooldown(
				credentialId,
				cooldownMs,
				"transient-provider-error",
				provider,
				false,
				message,
			);
		}

		this.usageService.clearCredential(provider, credentialId);
		return cooldownMs;
	}

	/**
	 * Clears transient provider-error backoff after a successful request.
	 */
	async clearTransientProviderError(
		provider: SupportedProviderId,
		credentialId: string,
	): Promise<void> {
		await this.storage.withLock((state) => {
			const providerState = getProviderState(state, provider);
			if (!providerState.credentialIds.includes(credentialId)) {
				return { result: undefined };
			}

			let didChange = false;
			if (providerState.transientErrorCount[credentialId] !== undefined) {
				delete providerState.transientErrorCount[credentialId];
				didChange = true;
			}
			if (providerState.lastTransientError?.[credentialId] !== undefined) {
				delete providerState.lastTransientError[credentialId];
				didChange = true;
			}
			if (
				typeof providerState.quotaExhaustedUntil[credentialId] === "number" &&
				providerState.quotaExhaustedUntil[credentialId] <= Date.now()
			) {
				delete providerState.quotaExhaustedUntil[credentialId];
				didChange = true;
			}

			return didChange ? { result: undefined, next: state } : { result: undefined };
		});
	}

	/**
	 * Clears the quota exhausted state for a credential (called on successful request).
	 * Resets weekly quota attempt counter.
	 */
	async clearQuotaExceeded(provider: SupportedProviderId, credentialId: string): Promise<void> {
		await this.storage.withLock((state) => {
			const providerState = getProviderState(state, provider);
			if (!providerState.credentialIds.includes(credentialId)) {
				return { result: undefined };
			}

			let didChange = false;
			if (providerState.quotaExhaustedUntil[credentialId] !== undefined) {
				delete providerState.quotaExhaustedUntil[credentialId];
				didChange = true;
			}
			if (providerState.lastQuotaError?.[credentialId] !== undefined) {
				delete providerState.lastQuotaError[credentialId];
				didChange = true;
			}
			if (providerState.weeklyQuotaAttempts?.[credentialId] !== undefined) {
				delete providerState.weeklyQuotaAttempts[credentialId];
				didChange = true;
			}
			if (providerState.quotaStates?.[credentialId] !== undefined) {
				delete providerState.quotaStates[credentialId];
				didChange = true;
			}

			return didChange ? { result: undefined, next: state } : { result: undefined };
		});
	}

	/**
	 * Updates rotation mode for a provider.
	 */
	async setRotationMode(provider: SupportedProviderId, rotationMode: RotationMode): Promise<void> {
		await this.flushLightweightRotationStateIfNeeded(provider);
		await this.storage.withLock((state) => {
			const providerState = getProviderState(state, provider);
			providerState.rotationMode = rotationMode;
			return { result: undefined, next: state };
		});
	}

	/**
	 * Returns true when balancer mode should be preferred for a provider.
	 */
	async shouldUseBalancerMode(provider: SupportedProviderId): Promise<boolean> {
		if (!USAGE_PROVIDER_IDS.has(provider)) {
			return true;
		}

		const state = await this.syncProviderState(provider);
		if (state.credentialIds.length === 0) {
			return false;
		}

		const credentialsById = await this.authWriter.getCredentials(state.credentialIds);
		for (const credentialId of state.credentialIds) {
			const credential = credentialsById.get(credentialId);
			if (!credential || credential.type !== "api_key") {
				return false;
			}
		}

		return true;
	}

	/**
	 * Auto-selects the best currently available credential for each provider.
	 */
	async autoActivatePreferredCredentials(options: AutoActivateOptions = {}): Promise<void> {
		await this.ensureInitialized();
		const providers = await this.providerRegistry.discoverProviderIds();
		for (const provider of providers) {
			let state = await this.syncProviderState(provider);
			if (state.credentialIds.length === 0) {
				continue;
			}

			if (state.manualActiveCredentialId) {
				const manualCredentialId = state.manualActiveCredentialId;
				const manualIndex = state.credentialIds.indexOf(manualCredentialId);
				if (manualIndex >= 0) {
					if (state.activeIndex !== manualIndex) {
						await this.storage.withLock((stored) => {
							const providerState = getProviderState(stored, provider);
							const nextManualIndex = providerState.credentialIds.indexOf(manualCredentialId);
							if (nextManualIndex >= 0) {
								providerState.activeIndex = nextManualIndex;
							}
							return { result: undefined, next: stored };
						});
					}
					continue;
				}

				await this.clearManualActiveCredential(provider);
				state = await this.syncProviderState(provider);
				if (state.credentialIds.length === 0) {
					continue;
				}
			}

			const disabledCredentialIds = await this.getDisabledCredentialIds(state);
			let now = Date.now();
			let available = buildAvailableSet(state, now, disabledCredentialIds);
			if (available.size === 0 && !options.avoidUsageApi) {
				await this.reconcileBlockedCredentialsFromUsage(provider, state, disabledCredentialIds);
				state = await this.syncProviderState(provider);
				now = Date.now();
				available = buildAvailableSet(state, now, disabledCredentialIds);
			}

			if (available.size === 0) {
				continue;
			}

			const usagePreferredIndex = options.avoidUsageApi
				? getUsageBasedCandidateIndex(state, available)
				: await this.getUsageBasedCandidateIndex(provider, state, available);
			const roundRobinIndex = getRoundRobinCandidateIndex(state, available);
			const selectedIndex = usagePreferredIndex ?? roundRobinIndex;
			if (selectedIndex === undefined) {
				continue;
			}

			await this.storage.withLock((stored) => {
				const providerState = getProviderState(stored, provider);
				if (selectedIndex < 0 || selectedIndex >= providerState.credentialIds.length) {
					return { result: undefined, next: stored };
				}

				providerState.activeIndex = selectedIndex;
				return { result: undefined, next: stored };
			});
		}
	}

	/**
	 * Returns provider IDs that currently have credentials in auth.json.
	 */
	async getProvidersWithCredentials(): Promise<SupportedProviderId[]> {
		await this.ensureInitialized();
		const providers = await this.providerRegistry.discoverProviderIds();
		const providersWithCredentials = new Set(await this.authWriter.listProviderIds(providers));
		return providers.filter((provider) => providersWithCredentials.has(provider));
	}

	/**
	 * Returns status information for providers that currently have credentials.
	 */
	async getStatus(): Promise<ProviderStatus[]> {
		const providers = await this.getProvidersWithCredentials();
		const statuses = await Promise.all(providers.map((provider) => this.getProviderStatus(provider)));
		return statuses.filter((status) => status.credentials.length > 0);
	}

	/**
	 * Returns status information for a single provider.
	 */
	async getProviderStatus(provider: SupportedProviderId): Promise<ProviderStatus> {
		const state = await this.syncProviderState(provider);
		const now = Date.now();
		const credentials: CredentialStatus[] = [];
		const credentialsById = await this.authWriter.getCredentials(state.credentialIds);

		for (let index = 0; index < state.credentialIds.length; index += 1) {
			const credentialId = state.credentialIds[index];
			const credential = credentialsById.get(credentialId);
			if (!credential) {
				continue;
			}

			const persistedFriendlyName = state.friendlyNames[credentialId];
			const inferredFriendlyName =
				credential.type === "oauth"
					? inferCredentialFriendlyName(provider, credentialId, credential)
					: undefined;
			const expiresAt = getCredentialExpiration(provider, credential);

			credentials.push({
				credentialId,
				credentialType: credential.type,
				redactedSecret: formatCredentialRedaction(credential),
				friendlyName: persistedFriendlyName ?? inferredFriendlyName,
				index,
				isActive: index === state.activeIndex,
				isManualActive: state.manualActiveCredentialId === credentialId,
				expiresAt,
				isExpired: typeof expiresAt === "number" ? expiresAt <= now : false,
				quotaExhaustedUntil: state.quotaExhaustedUntil[credentialId],
				usageCount: state.usageCount[credentialId] ?? 0,
				quotaErrorCount: state.quotaErrorCount[credentialId] ?? 0,
				transientErrorCount: state.transientErrorCount?.[credentialId],
				weeklyQuotaAttempts: state.weeklyQuotaAttempts?.[credentialId],
				lastQuotaError: state.lastQuotaError?.[credentialId],
				lastTransientError: state.lastTransientError?.[credentialId],
				lastUsedAt: state.lastUsedAt[credentialId],
				disabledError: state.disabledCredentials?.[credentialId]?.error,
			});
		}

		return {
			provider,
			rotationMode: state.rotationMode,
			activeIndex: state.activeIndex,
			manualActiveCredentialId: state.manualActiveCredentialId,
			credentials,
		};
	}

	private async getDisabledCredentialIds(state: ProviderRotationState): Promise<Set<string>> {
		const disabledCredentialIds = new Set<string>();
		for (const credentialId of Object.keys(state.disabledCredentials)) {
			if (state.credentialIds.includes(credentialId)) {
				disabledCredentialIds.add(credentialId);
			}
		}
		return disabledCredentialIds;
	}

	private async releaseOneCooldownLockForProviderWithoutUsage(
		provider: SupportedProviderId,
		state: ProviderRotationState,
		excludedCredentialIds?: Set<string>,
	): Promise<ProviderRotationState | null> {
		if (this.usageService.hasProvider(provider)) {
			return null;
		}

		const now = Date.now();
		let candidateCredentialId: string | null = null;
		let candidateExhaustedUntil = Number.POSITIVE_INFINITY;

		for (const credentialId of state.credentialIds) {
			if (excludedCredentialIds?.has(credentialId)) {
				continue;
			}

			const exhaustedUntil = state.quotaExhaustedUntil[credentialId];
			if (typeof exhaustedUntil !== "number" || exhaustedUntil <= now) {
				continue;
			}

			if (exhaustedUntil < candidateExhaustedUntil) {
				candidateCredentialId = credentialId;
				candidateExhaustedUntil = exhaustedUntil;
			}
		}

		if (!candidateCredentialId) {
			return null;
		}

		const didUpdate = await this.storage.withLock((stored) => {
			const providerState = getProviderState(stored, provider);
			const currentExhaustedUntil = providerState.quotaExhaustedUntil[candidateCredentialId];
			if (typeof currentExhaustedUntil !== "number" || currentExhaustedUntil <= Date.now()) {
				return { result: false };
			}

			delete providerState.quotaExhaustedUntil[candidateCredentialId];
			return { result: true, next: stored };
		});

		if (!didUpdate) {
			return null;
		}

		this.usageService.clearCredential(provider, candidateCredentialId);
		return this.syncProviderState(provider);
	}

	private async getUsageBasedCandidateIndex(
		provider: SupportedProviderId,
		state: ProviderRotationState,
		available: Set<string>,
		usageContext?: CredentialUsageContext,
	): Promise<number | undefined> {
		throwIfAborted(
			usageContext?.signal,
			`Usage-based credential selection aborted for ${provider}.`,
		);
		const fallbackIndex = getUsageBasedCandidateIndex(state, available);
		const candidates = state.credentialIds
			.map((credentialId, index) => ({
				credentialId,
				index,
				usageCount: state.usageCount[credentialId] ?? 0,
				quotaErrorCount: state.quotaErrorCount[credentialId] ?? 0,
				lastUsedAt: state.lastUsedAt[credentialId] ?? 0,
			}))
			.filter((candidate) => available.has(candidate.credentialId));

		if (candidates.length === 0) {
			return undefined;
		}

		const usageResults = await Promise.allSettled(
			candidates.map((candidate) =>
				this.getCredentialUsageSnapshotWithContext(
					provider,
					candidate.credentialId,
					{
						maxAgeMs: SELECTION_USAGE_MAX_AGE_MS,
					},
					usageContext,
				),
			),
		);

		throwIfAborted(
			usageContext?.signal,
			`Usage-based credential selection aborted for ${provider}.`,
		);

		const ranked = candidates
			.map((candidate, index) => {
				const usageResult = usageResults[index];
				if (usageResult?.status !== "fulfilled") {
					return {
						...candidate,
						hasUsageSnapshot: false,
						isUntouched: false,
						resetAt: null,
						quotaState: { state: "unknown" } as UsageQuotaState,
					};
				}

				const snapshot = usageResult.value.snapshot;
				return {
					...candidate,
					hasUsageSnapshot: snapshot !== null,
					isUntouched: isUsageSnapshotUntouched(snapshot),
					resetAt: getUsageSnapshotResetAt(snapshot),
					quotaState: inferQuotaStateFromUsage(snapshot),
				};
			})
			.filter((candidate) => candidate.quotaState.state !== "exhausted");

		if (ranked.length === 0) {
			return undefined;
		}

		const hasUsageSignals = ranked.some((candidate) => candidate.hasUsageSnapshot);
		if (!hasUsageSignals) {
			return fallbackIndex ?? ranked[0]?.index;
		}

		ranked.sort((left, right) => {
			if (left.hasUsageSnapshot !== right.hasUsageSnapshot) {
				return left.hasUsageSnapshot ? -1 : 1;
			}
			if (left.isUntouched !== right.isUntouched) {
				return left.isUntouched ? -1 : 1;
			}
			if (left.resetAt !== right.resetAt) {
				if (left.resetAt === null) {
					return 1;
				}
				if (right.resetAt === null) {
					return -1;
				}
				return left.resetAt - right.resetAt;
			}
			if (left.quotaErrorCount !== right.quotaErrorCount) {
				return left.quotaErrorCount - right.quotaErrorCount;
			}
			if (left.usageCount !== right.usageCount) {
				return left.usageCount - right.usageCount;
			}
			if (left.lastUsedAt !== right.lastUsedAt) {
				return left.lastUsedAt - right.lastUsedAt;
			}
			return left.index - right.index;
		});

		return ranked[0]?.index ?? fallbackIndex;
	}

	private async reconcileBlockedCredentialsFromUsage(
		provider: SupportedProviderId,
		state: ProviderRotationState,
		excludedCredentialIds?: Set<string>,
		usageContext?: CredentialUsageContext,
	): Promise<void> {
		throwIfAborted(
			usageContext?.signal,
			`Blocked credential reconciliation aborted for ${provider}.`,
		);
		const now = Date.now();
		const blockedCredentialIds = state.credentialIds.filter((credentialId) => {
			if (excludedCredentialIds?.has(credentialId)) {
				return false;
			}
			const exhaustedUntil = state.quotaExhaustedUntil[credentialId];
			return typeof exhaustedUntil === "number" && exhaustedUntil > now;
		});
		if (blockedCredentialIds.length === 0) {
			return;
		}

		await Promise.allSettled(
			blockedCredentialIds.map(async (credentialId) => {
				await this.getCredentialUsageSnapshotWithContext(
					provider,
					credentialId,
					{
						forceRefresh: true,
						maxAgeMs: BLOCKED_RECONCILE_USAGE_MAX_AGE_MS,
					},
					usageContext,
				);
			}),
		);
		throwIfAborted(
			usageContext?.signal,
			`Blocked credential reconciliation aborted for ${provider}.`,
		);
	}

	private async reconcileQuotaStateFromUsage(
		provider: SupportedProviderId,
		credentialId: string,
		snapshot: UsageSnapshot | null,
	): Promise<void> {
		const quotaState = inferQuotaStateFromUsage(snapshot);
		if (quotaState.state === "unknown") {
			return;
		}

		const classificationResult = quotaClassifier.classifyFromUsage(
			snapshot?.primary ?? null,
			snapshot?.secondary ?? null,
			snapshot?.rateLimitHeaders,
		);
		const didUpdateState = await this.storage.withLock((state) => {
			const providerState = getProviderState(state, provider);
			if (!providerState.credentialIds.includes(credentialId)) {
				return { result: false };
			}

			if (quotaState.state === "available") {
				const hadPersistedState =
					providerState.quotaExhaustedUntil[credentialId] !== undefined ||
					providerState.quotaStates?.[credentialId] !== undefined;
				delete providerState.quotaExhaustedUntil[credentialId];
				if (providerState.quotaStates?.[credentialId] !== undefined) {
					delete providerState.quotaStates[credentialId];
				}
				return hadPersistedState ? { result: true, next: state } : { result: false };
			}

			const now = Date.now();
			const fallbackUntil = now + QUOTA_COOLDOWN_MS;
			const nextUntil = Math.max(
				now + MIN_QUOTA_RETRY_WINDOW_MS,
				quotaState.exhaustedUntil ?? classificationResult.window?.windowEndMs ?? fallbackUntil,
			);
			const currentUntil = providerState.quotaExhaustedUntil[credentialId] ?? 0;
			providerState.quotaExhaustedUntil[credentialId] = Math.max(currentUntil, nextUntil);
			providerState.quotaStates = providerState.quotaStates ?? {};
			providerState.quotaStates[credentialId] = {
				...this.buildQuotaState(credentialId, "Quota inferred from usage snapshot", classificationResult),
				resetAt: nextUntil,
			};
			return { result: true, next: state };
		});

		if (didUpdateState) {
			this.usageService.clearCredential(provider, credentialId);
		}
	}

	private async refreshIfNeeded(
		provider: SupportedProviderId,
		credentialId: string,
		credential: StoredOAuthCredential,
		signal?: AbortSignal,
	): Promise<StoredOAuthCredential> {
		if (!this.isOAuthRefreshManagedForProvider(provider)) {
			return credential;
		}

		const safetyWindowMs = getOAuthRefreshLeadTimeMs(
			provider,
			this.extensionConfig.oauthRefresh.safetyWindowMs,
		);
		if (Date.now() < credential.expires - safetyWindowMs) {
			return credential;
		}

		try {
			const refreshedCredential = await this.refreshCredentialToken(
				provider,
				credentialId,
				credential,
				signal,
			);
			this.scheduleOAuthRefresh(provider, credentialId, refreshedCredential);
			await this.persistOAuthRefreshSchedule(provider);
			return refreshedCredential;
		} catch (error) {
			if (
				isOAuthRefreshFailureError(error) &&
				shouldPreserveActiveOAuthCredentialAfterRefreshFailure(provider, credential, error)
			) {
				return credential;
			}
			throw error;
		}
	}

	private async refreshCredentialToken(
		provider: SupportedProviderId,
		credentialId: string,
		credential: StoredOAuthCredential,
		signal?: AbortSignal,
	): Promise<StoredOAuthCredential> {
		this.assertOAuthRefreshManagedForProvider(provider);
		const refreshKey = `${provider}:${credentialId}`;
		const inFlightRefresh = this.oauthRefreshInFlight.get(refreshKey);
		if (inFlightRefresh) {
			return raceWithSignal(
				inFlightRefresh,
				signal,
				`OAuth refresh aborted for ${provider}/${credentialId}.`,
			);
		}

		const refreshPromise = (async (): Promise<StoredOAuthCredential> => {
			let refreshed: OAuthCredentials;
			try {
				refreshed = await refreshOAuthCredential(provider, credential, {
					requestTimeoutMs: this.extensionConfig.oauthRefresh.requestTimeoutMs,
				});
			} catch (error) {
				const recoveredCredential = await this.tryRecoverConcurrentCodexRefresh(
					provider,
					credentialId,
					credential,
					error,
				);
				if (recoveredCredential) {
					return recoveredCredential;
				}

				const failure = await this.logAndHandleOAuthRefreshFailure(
					provider,
					credentialId,
					credential,
					error,
				);
				throw failure;
			}

			await this.authWriter.setOAuthCredential(credentialId, refreshed);
			await this.clearRecoveredOAuthRefreshFailureState(provider, credentialId, {
				type: "oauth",
				...refreshed,
			});
			return {
				type: "oauth",
				...refreshed,
			};
		})().finally(() => {
			this.oauthRefreshInFlight.delete(refreshKey);
		});

		this.oauthRefreshInFlight.set(refreshKey, refreshPromise);
		return raceWithSignal(
			refreshPromise,
			signal,
			`OAuth refresh aborted for ${provider}/${credentialId}.`,
		);
	}

	private deduplicateCredentialEntries(
		provider: SupportedProviderId,
		credentialEntries: readonly AuthCredentialEntry[],
	): string[] {
		const credentialIds = credentialEntries.map((entry) => entry.credentialId);
		if ((provider !== "openai-codex" && provider !== "cline") || credentialIds.length <= 1) {
			return credentialIds;
		}

		const selectedByIdentity = new Map<
			string,
			{ credentialId: string; expiresAt: number; index: number }
		>();

		for (const [index, entry] of credentialEntries.entries()) {
			if (entry.credential.type !== "oauth") {
				continue;
			}

			const identityKey =
				provider === "cline"
					? buildClineIdentityKey(entry.credential)
					: buildCodexIdentityKey(entry.credentialId, entry.credential);
			if (!identityKey) {
				continue;
			}

			const existing = selectedByIdentity.get(identityKey);
			if (!existing) {
				selectedByIdentity.set(identityKey, {
					credentialId: entry.credentialId,
					expiresAt: entry.credential.expires,
					index,
				});
				continue;
			}

			const shouldReplace =
				entry.credential.expires > existing.expiresAt ||
				(entry.credential.expires === existing.expiresAt && index < existing.index);
			if (shouldReplace) {
				selectedByIdentity.set(identityKey, {
					credentialId: entry.credentialId,
					expiresAt: entry.credential.expires,
					index,
				});
			}
		}

		if (selectedByIdentity.size === 0) {
			return credentialIds;
		}

		const retainedCredentialIds = new Set(
			[...selectedByIdentity.values()].map((entry) => entry.credentialId),
		);
		return credentialIds.filter((credentialId) => retainedCredentialIds.has(credentialId));
	}

	private async syncProviderState(provider: SupportedProviderId): Promise<ProviderRotationState> {
		await this.ensureInitialized();
		const isLightweightProvider = this.isLightweightRotationProvider(provider);
		const credentialEntries = await this.authWriter.getProviderCredentialEntries(provider);
		const credentialIds = credentialEntries.map((entry) => entry.credentialId);
		const normalizedCredentialIds = this.deduplicateCredentialEntries(provider, credentialEntries);
		const normalizedCredentialIdSet = new Set(normalizedCredentialIds);
		for (const credentialId of credentialIds) {
			if (!normalizedCredentialIdSet.has(credentialId)) {
				this.usageService.clearCredential(provider, credentialId);
			}
		}

		const currentProviderState = cloneProviderState(
			await this.storage.readProviderState(provider),
		);
		const normalizedProviderState = cloneProviderState(currentProviderState);
		normalizedProviderState.credentialIds = [...normalizedCredentialIds];
		if (provider === "openai-codex") {
			migrateLegacyCodexRefreshDisabledCredentials(normalizedProviderState);
		}
		normalizeProviderState(normalizedProviderState);
		clearRecoveredOAuthRefreshFailureStateForProvider(
			provider,
			normalizedProviderState,
			credentialEntries,
		);
		if (provider === "cline" || !this.isOAuthRefreshManagedForProvider(provider)) {
			clearDisabledOAuthRefreshFailureStateForProvider(provider, normalizedProviderState);
		}

		if (haveEquivalentProviderState(currentProviderState, normalizedProviderState)) {
			const effectiveProviderState = isLightweightProvider
				? this.applyLightweightRotationState(provider, cloneProviderState(currentProviderState))
				: currentProviderState;
			this.loadProviderTelemetry(provider, effectiveProviderState);
			await this.syncProviderOAuthSchedules(provider, effectiveProviderState, credentialEntries);
			return effectiveProviderState;
		}

		const providerState = await this.storage.withLock((state) => {
			const storedProviderState = getProviderState(state, provider);
			storedProviderState.credentialIds = [...normalizedCredentialIds];
			if (provider === "openai-codex") {
				migrateLegacyCodexRefreshDisabledCredentials(storedProviderState);
			}
			normalizeProviderState(storedProviderState);
			clearRecoveredOAuthRefreshFailureStateForProvider(
				provider,
				storedProviderState,
				credentialEntries,
			);
			if (provider === "cline" || !this.isOAuthRefreshManagedForProvider(provider)) {
				clearDisabledOAuthRefreshFailureStateForProvider(provider, storedProviderState);
			}
			return {
				result: cloneProviderState(storedProviderState),
				next: state,
			};
		});
		const effectiveProviderState = isLightweightProvider
			? this.applyLightweightRotationState(provider, cloneProviderState(providerState))
			: providerState;
		this.loadProviderTelemetry(provider, effectiveProviderState);
		await this.syncProviderOAuthSchedules(provider, effectiveProviderState, credentialEntries);
		return effectiveProviderState;
	}

	/**
	 * Ensures the multi-auth.json file exists and contains provider slots.
	 */
	async ensureInitialized(): Promise<void> {
		if (this.initializationPromise) {
			return this.initializationPromise;
		}

		const initializationPromise = (async () => {
			const providers = await this.providerRegistry.discoverProviderIds();
			const normalizedProviders = await this.authWriter.normalizeProviderCredentials(providers);
			for (const result of normalizedProviders) {
				this.usageService.clearProvider(result.provider);
			}
			const credentialIdsByProvider = new Map<SupportedProviderId, string[]>();
			const credentialEntriesByProvider = new Map<SupportedProviderId, readonly AuthCredentialEntry[]>();
			for (const provider of providers) {
				const credentialEntries = await this.authWriter.getProviderCredentialEntries(provider);
				credentialEntriesByProvider.set(provider, credentialEntries);
				const credentialIds = credentialEntries.map((entry) => entry.credentialId);
				const normalizedCredentialIds = this.deduplicateCredentialEntries(provider, credentialEntries);
				credentialIdsByProvider.set(provider, normalizedCredentialIds);
				const normalizedCredentialIdSet = new Set(normalizedCredentialIds);
				for (const credentialId of credentialIds) {
					if (!normalizedCredentialIdSet.has(credentialId)) {
						this.usageService.clearCredential(provider, credentialId);
					}
				}
			}

			const persistedProviders = await this.storage.withLock((state) => {
				for (const provider of providers) {
					const providerState = getProviderState(state, provider);
					providerState.credentialIds = [...(credentialIdsByProvider.get(provider) ?? [])];
					if (provider === "openai-codex") {
						migrateLegacyCodexRefreshDisabledCredentials(providerState);
					}
					normalizeProviderState(providerState);
					if (provider === "cline" || !this.isOAuthRefreshManagedForProvider(provider)) {
						clearDisabledOAuthRefreshFailureStateForProvider(provider, providerState);
					}
				}
				for (const result of normalizedProviders) {
					const providerState = getProviderState(state, result.provider);
					applyCredentialNormalization(providerState, result);
					if (result.provider === "openai-codex") {
						migrateLegacyCodexRefreshDisabledCredentials(providerState);
						normalizeProviderState(providerState);
					}
				}

				state.ui.hiddenProviders = [...new Set(state.ui.hiddenProviders)];
				return {
					result: Object.fromEntries(
						providers.map((provider) => [provider, cloneProviderState(getProviderState(state, provider))]),
					),
					next: state as MultiAuthState,
				};
			});
			for (const [provider, providerState] of Object.entries(persistedProviders)) {
				this.loadProviderTelemetry(provider, providerState);
				await this.syncProviderOAuthSchedules(
					provider,
					providerState,
					credentialEntriesByProvider.get(provider),
				);
			}
		})();

		this.initializationPromise = initializationPromise;

		try {
			await initializationPromise;
		} catch (error) {
			if (this.initializationPromise === initializationPromise) {
				this.initializationPromise = null;
			}
			throw error;
		}
	}

	private loadProviderTelemetry(
		_provider: SupportedProviderId,
		providerState: ProviderRotationState,
	): void {
		this.cascadeStateManager.loadFromState(providerState.cascadeState);
		this.healthScorer.loadState(providerState.healthState);
	}

	private async persistProviderTelemetry(provider: SupportedProviderId): Promise<void> {
		if (this.isLightweightRotationProvider(provider)) {
			const providerState = this.applyLightweightRotationState(
				provider,
				await this.storage.readProviderState(provider),
			);
			this.recordLightweightTelemetry(provider, providerState.credentialIds);
			await this.lightweightRotationState.flushProvider(provider);
			return;
		}
		await this.storage.withLock((state) => {
			const storedProviderState = getProviderState(state, provider);
			const nextCascadeState = {
				[provider]: this.cascadeStateManager.getProviderState(provider),
			};
			const nextHealthState = this.healthScorer.exportState(storedProviderState.credentialIds);
			const didChange =
				!haveSameJsonValue(storedProviderState.cascadeState, nextCascadeState) ||
				!haveSameJsonValue(storedProviderState.healthState, nextHealthState);
			if (!didChange) {
				return { result: undefined };
			}
			storedProviderState.cascadeState = nextCascadeState;
			storedProviderState.healthState = nextHealthState;
			normalizeProviderState(storedProviderState);
			return { result: undefined, next: state };
		});
	}

	private scheduleOAuthRefresh(
		provider: SupportedProviderId,
		credentialId: string,
		credential: StoredOAuthCredential,
	): void {
		if (!this.isOAuthRefreshManagedForProvider(provider)) {
			this.oauthRefreshScheduler.cancelRefresh(credentialId);
			return;
		}

		const expiration = determineTokenExpiration(credential.access, credential.expires);
		const scheduledExpiration = getSchedulerExpirationForRefreshLeadTime(
			provider,
			expiration.expiresAt,
			this.extensionConfig.oauthRefresh.safetyWindowMs,
		);
		this.oauthRefreshScheduler.scheduleRefresh(credentialId, provider, scheduledExpiration);
	}

	private async syncProviderOAuthSchedules(
		provider: SupportedProviderId,
		providerState: ProviderRotationState,
		credentialEntries?: readonly AuthCredentialEntry[],
	): Promise<void> {
		if (!this.isOAuthRefreshManagedForProvider(provider)) {
			for (const credentialId of providerState.credentialIds) {
				this.oauthRefreshScheduler.cancelRefresh(credentialId);
			}
			for (const credentialId of Object.keys(providerState.oauthRefreshScheduled ?? {})) {
				this.oauthRefreshScheduler.cancelRefresh(credentialId);
			}
			await this.persistOAuthRefreshSchedule(provider);
			return;
		}

		const validCredentialIds = new Set(providerState.credentialIds);
		const availableCredentialIds = buildAvailableSet(providerState, Date.now());
		const credentialsById = credentialEntries
			? new Map(credentialEntries.map((entry) => [entry.credentialId, entry.credential]))
			: await this.authWriter.getCredentials(providerState.credentialIds);
		for (const credentialId of providerState.credentialIds) {
			const credential = credentialsById.get(credentialId);
			if (credential?.type === "oauth" && availableCredentialIds.has(credentialId)) {
				this.scheduleOAuthRefresh(provider, credentialId, credential);
			} else {
				this.oauthRefreshScheduler.cancelRefresh(credentialId);
			}
		}
		for (const credentialId of Object.keys(providerState.oauthRefreshScheduled ?? {})) {
			if (!validCredentialIds.has(credentialId)) {
				this.oauthRefreshScheduler.cancelRefresh(credentialId);
			}
		}
		await this.persistOAuthRefreshSchedule(provider);
	}

	private async persistOAuthRefreshSchedule(provider: SupportedProviderId): Promise<void> {
		const scheduled = this.oauthRefreshScheduler.getPendingRefreshes();
		await this.storage.withLock((state) => {
			const providerState = getProviderState(state, provider);
			const nextScheduled: Record<string, number> = {};
			for (const credentialId of providerState.credentialIds) {
				const scheduledEntry = scheduled.get(credentialId);
				if (scheduledEntry?.providerId === provider) {
					nextScheduled[credentialId] = scheduledEntry.scheduledAt;
				}
			}
			const currentScheduled = providerState.oauthRefreshScheduled ?? {};
			if (haveSameNumberRecord(currentScheduled, nextScheduled)) {
				return { result: undefined };
			}
			providerState.oauthRefreshScheduled = nextScheduled;
			return { result: undefined, next: state };
		});
	}

	private async refreshScheduledOAuthCredential(
		provider: SupportedProviderId,
		credentialId: string,
	): Promise<number | undefined> {
		if (!this.isOAuthRefreshManagedForProvider(provider)) {
			this.oauthRefreshScheduler.cancelRefresh(credentialId);
			await this.persistOAuthRefreshSchedule(provider);
			return undefined;
		}

		const credential = await this.authWriter.getCredential(credentialId);
		if (!credential || credential.type !== "oauth") {
			this.oauthRefreshScheduler.cancelRefresh(credentialId);
			await this.persistOAuthRefreshSchedule(provider);
			return undefined;
		}

		try {
			const refreshed = await this.refreshCredentialToken(provider, credentialId, credential);
			this.scheduleOAuthRefresh(provider, credentialId, refreshed);
			await this.persistOAuthRefreshSchedule(provider);
			return determineTokenExpiration(refreshed.access, refreshed.expires).expiresAt;
		} catch (error) {
			if (isOAuthRefreshFailureError(error) && error.details.permanent) {
				throw error;
			}
			return undefined;
		}
	}

	private async resolveCredentialModelEligibility(
		provider: SupportedProviderId,
		credentialIds: readonly string[],
		modelId: string | undefined,
		usageContext?: CredentialUsageContext,
		signal?: AbortSignal,
	): Promise<CredentialModelEligibility> {
		const effectiveSignal = signal ?? usageContext?.signal;
		throwIfAborted(
			effectiveSignal,
			`Model eligibility resolution aborted for ${provider}/${modelId ?? "unknown"}.`,
		);
		const normalizedModelId = normalizeModelId(modelId) ?? undefined;
		if (!modelRequiresEntitlement(provider, normalizedModelId)) {
			return {
				appliesConstraint: false,
				eligibleCredentialIds: [...credentialIds],
				ineligibleCredentialIds: [],
			};
		}

		const usageResults = await Promise.allSettled(
			credentialIds.map((credentialId) =>
				this.getCredentialUsageSnapshotWithContext(
					provider,
					credentialId,
					{
						maxAgeMs: SELECTION_USAGE_MAX_AGE_MS,
					},
					usageContext,
				),
			),
		);

		throwIfAborted(
			effectiveSignal,
			`Model eligibility resolution aborted for ${provider}/${normalizedModelId ?? "unknown"}.`,
		);

		const verifiedEligibleCredentialIds: string[] = [];
		const usageFailureCredentialIds: string[] = [];
		const ineligibleCredentialIds: string[] = [];
		let hasUnknownPlanType = false;
		let hasUsageFailure = false;
		const allowUnverifiedOnUsageFailure =
			provider === "openai-codex" &&
			this.extensionConfig.modelEntitlements.codex.usageLookupFailureMode === "allow-unverified";

		for (let index = 0; index < credentialIds.length; index += 1) {
			const credentialId = credentialIds[index];
			const usageResult = usageResults[index];

			if (usageResult.status === "rejected") {
				usageFailureCredentialIds.push(credentialId);
				hasUsageFailure = true;
				continue;
			}

			const usage = usageResult.value;
			const snapshot = usage.snapshot;
			if (!snapshot) {
				if (usage.error) {
					usageFailureCredentialIds.push(credentialId);
					hasUsageFailure = true;
				} else {
					ineligibleCredentialIds.push(credentialId);
					hasUnknownPlanType = true;
				}
				continue;
			}

			const planType = normalizeCodexPlanType(snapshot.planType);
			if (isPlanEligibleForModel(planType)) {
				verifiedEligibleCredentialIds.push(credentialId);
				continue;
			}

			ineligibleCredentialIds.push(credentialId);
			if (planType === "unknown") {
				hasUnknownPlanType = true;
			}
		}

		let eligibleCredentialIds = [...verifiedEligibleCredentialIds];
		if (eligibleCredentialIds.length === 0 && allowUnverifiedOnUsageFailure && usageFailureCredentialIds.length > 0) {
			eligibleCredentialIds = [...usageFailureCredentialIds];
			multiAuthDebugLogger.log("codex_entitlement_usage_failure_bypass", {
				provider,
				modelId: normalizedModelId ?? "unknown",
				credentialIds: usageFailureCredentialIds,
			});
		} else {
			for (const credentialId of usageFailureCredentialIds) {
				ineligibleCredentialIds.push(credentialId);
			}
		}

		let failureMessage: string | undefined;
		if (eligibleCredentialIds.length === 0) {
			if (hasUsageFailure) {
				failureMessage = `Unable to verify plan eligibility for ${formatModelReference(provider, normalizedModelId ?? "unknown")}. All credentials failed usage lookup.`;
			} else if (hasUnknownPlanType) {
				failureMessage = `Unable to determine plan type for any credential. Cannot verify eligibility for ${formatModelReference(provider, normalizedModelId ?? "unknown")}.`;
			} else {
				failureMessage = `No credentials available with a paid plan for ${formatModelReference(provider, normalizedModelId ?? "unknown")}. Upgrade to ChatGPT Plus, Pro, Team, Business, or Enterprise to use this model.`;
			}
		}

		return {
			appliesConstraint: true,
			eligibleCredentialIds,
			ineligibleCredentialIds,
			failureMessage,
		};
	}
}
