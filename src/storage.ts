import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	DEBUG_DIR,
	DEFAULT_HISTORY_PERSISTENCE_CONFIG,
	cloneHistoryPersistenceConfig,
	type HistoryPersistenceConfig,
} from "./config.js";
import { isRetryableFileAccessError, readTextSnapshotWithRetries, writeTextSnapshotWithRetries } from "./file-retry.js";
import { MultiAuthHistoryStore } from "./history-storage.js";
import { RollingMetricSeries, type MetricSeriesSnapshot } from "./performance-metrics.js";
import { resolveDefaultRotationMode } from "./rotation-modes.js";
import { resolveAgentRuntimePath } from "./runtime-paths.js";
import { DEFAULT_PROVIDER_POOL_CONFIG, type ProviderPoolConfig } from "./types-pool.js";
import {
	type MultiAuthState,
	type ProviderRotationState,
	type RotationMode,
	type SupportedProviderId,
} from "./types.js";

type LockResult<T> = {
	result: T;
	next?: MultiAuthState;
};

type LockRetryOptions = {
	retries: number;
	factor: number;
	minTimeout: number;
	maxTimeout: number;
	randomize: boolean;
};

type LockOptions = {
	realpath?: boolean;
	retries: LockRetryOptions;
	stale: number;
	onCompromised?: (error: Error) => void;
};

type LockObserver = {
	onRetry?: (delayMs: number) => void;
	onAcquired?: (latencyMs: number) => void;
};

type CachedStorageSnapshot = {
	state: MultiAuthState;
	fingerprint: string;
	serializedState: string;
};

export interface MultiAuthStorageMetrics {
	readLatencyMs: MetricSeriesSnapshot;
	writeLatencyMs: MetricSeriesSnapshot;
	lockAcquisitionLatencyMs: MetricSeriesSnapshot;
	statePayloadBytes: MetricSeriesSnapshot;
	cacheHitCount: number;
	cacheMissCount: number;
	cacheHitRate: number;
	lockRetryCount: number;
	lastKnownStateSizeBytes: number;
}

export interface MultiAuthStorageOptions {
	debugDir?: string;
	historyPersistence?: HistoryPersistenceConfig;
}

function toError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}

	return new Error(String(error));
}

function sleep(ms: number): Promise<void> {
	if (ms <= 0) {
		return Promise.resolve();
	}

	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function lockDirPath(filePath: string): string {
	return `${filePath}.lock`;
}

async function acquireFileLock(
	filePath: string,
	options: LockOptions,
	observer: LockObserver = {},
): Promise<() => Promise<void>> {
	const lockPath = lockDirPath(filePath);
	const maxAttempts = Math.max(0, options.retries.retries) + 1;
	const startedAt = Date.now();

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			await mkdir(lockPath, { mode: 0o700 });
			observer.onAcquired?.(Date.now() - startedAt);
			return async () => {
				await rm(lockPath, { recursive: true, force: true });
			};
		} catch (error) {
			const lockError = toError(error);
			const maybeCode = (lockError as Error & { code?: unknown }).code;

			if (maybeCode !== "EEXIST") {
				throw lockError;
			}

			try {
				const lockStats = await stat(lockPath);
				const ageMs = Date.now() - lockStats.mtimeMs;
				if (ageMs > options.stale) {
					await rm(lockPath, { recursive: true, force: true });
					if (options.onCompromised) {
						options.onCompromised(
							new Error(`Removed stale lock '${lockPath}' older than ${Math.round(ageMs)}ms.`),
						);
					}
					// Decrement attempt so we retry the mkdir immediately after removing stale lock
					attempt -= 1;
					continue;
				}
			} catch {
				// Lock may be released while checking staleness; retry.
			}

			if (attempt >= maxAttempts) {
				throw new Error(`Timed out acquiring lock for '${filePath}' after ${maxAttempts} attempt(s).`);
			}

			const baseDelay = Math.min(
				options.retries.maxTimeout,
				Math.max(
					options.retries.minTimeout,
					Math.round(options.retries.minTimeout * Math.pow(options.retries.factor, attempt - 1)),
				),
			);
			const delay = options.retries.randomize
				? Math.round(baseDelay * (0.5 + Math.random()))
				: baseDelay;
			observer.onRetry?.(delay);
			await sleep(delay);
		}
	}

	throw new Error(`Failed to acquire lock for '${filePath}'.`);
}

/**
 * Creates a blank provider rotation state.
 */
export function createEmptyProviderState(
	rotationMode: RotationMode = "round-robin",
): ProviderRotationState {
	return {
		credentialIds: [],
		activeIndex: 0,
		rotationMode,
		manualActiveCredentialId: undefined,
		lastUsedAt: {},
		usageCount: {},
		quotaErrorCount: {},
		quotaExhaustedUntil: {},
		lastQuotaError: {},
		lastTransientError: {},
		transientErrorCount: {},
		weeklyQuotaAttempts: {},
		friendlyNames: {},
		disabledCredentials: {},
		cascadeState: undefined,
		healthState: undefined,
		oauthRefreshScheduled: {},
		pools: undefined,
		poolConfig: undefined,
		poolState: undefined,
		chains: undefined,
		activeChain: undefined,
		quotaStates: undefined,
	};
}

function createProviderStateMap(providers: readonly string[]): Record<string, ProviderRotationState> {
	const result: Record<string, ProviderRotationState> = {};
	for (const provider of providers) {
		result[provider] = createEmptyProviderState(resolveDefaultRotationMode(provider));
	}
	return result;
}

/**
 * Creates the default top-level pi-multi-auth state.
 */
export function createDefaultMultiAuthState(providers: readonly string[] = []): MultiAuthState {
	return {
		version: 1,
		providers: createProviderStateMap(providers),
		ui: {
			hiddenProviders: [],
		},
	};
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function ensureParentDir(filePath: string): Promise<void> {
	const parentDir = dirname(filePath);
	if (!(await pathExists(parentDir))) {
		await mkdir(parentDir, { recursive: true, mode: 0o700 });
	}
}

async function ensureFileExists(filePath: string): Promise<void> {
	if (!(await pathExists(filePath))) {
		await writeFile(filePath, JSON.stringify(createDefaultMultiAuthState(), null, 2), "utf-8");
		await chmod(filePath, 0o600);
	}
}

function getDefaultMultiAuthPath(): string {
	return resolveAgentRuntimePath("multi-auth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProviderState(
	provider: SupportedProviderId,
	value: unknown,
): ProviderRotationState {
	if (!isRecord(value)) {
		return createEmptyProviderState(resolveDefaultRotationMode(provider));
	}

	const credentialIds = Array.isArray(value.credentialIds)
		? value.credentialIds.filter((item): item is string => typeof item === "string")
		: [];

	const activeIndexRaw = value.activeIndex;
	const activeIndex =
		typeof activeIndexRaw === "number" && Number.isInteger(activeIndexRaw) && activeIndexRaw >= 0
			? activeIndexRaw
			: 0;

	const rotationModeRaw = value.rotationMode;
	const rotationMode: RotationMode =
		rotationModeRaw === "usage-based" ||
		rotationModeRaw === "round-robin" ||
		rotationModeRaw === "balancer"
			? rotationModeRaw
			: resolveDefaultRotationMode(provider);

	const manualActiveCredentialId =
		typeof value.manualActiveCredentialId === "string" &&
		value.manualActiveCredentialId.trim().length > 0
			? value.manualActiveCredentialId.trim()
			: undefined;

	return {
		credentialIds,
		activeIndex,
		rotationMode,
		manualActiveCredentialId,
		lastUsedAt: parseNumberMap(value.lastUsedAt),
		usageCount: parseNumberMap(value.usageCount),
		quotaErrorCount: parseNumberMap(value.quotaErrorCount),
		quotaExhaustedUntil: parseNumberMap(value.quotaExhaustedUntil),
		lastQuotaError: parseStringMap(value.lastQuotaError),
		lastTransientError: parseStringMap(value.lastTransientError),
		transientErrorCount: parseNumberMap(value.transientErrorCount),
		weeklyQuotaAttempts: parseNumberMap(value.weeklyQuotaAttempts),
		friendlyNames: parseStringMap(value.friendlyNames),
		disabledCredentials: parseDisabledCredentials(value.disabledCredentials),
		cascadeState: parseCascadeState(value.cascadeState),
		healthState: parseHealthState(value.healthState),
		oauthRefreshScheduled: parseNumberMap(value.oauthRefreshScheduled),
		pools: parsePools(value.pools),
		poolConfig: parsePoolConfig(value.poolConfig),
		poolState: parsePoolState(value.poolState),
		chains: parseChains(value.chains),
		activeChain: parseActiveChain(value.activeChain),
		quotaStates: parseQuotaStates(value.quotaStates),
	};
}

function parseDisabledCredentials(
	value: unknown,
): Record<string, { error: string; disabledAt: number }> {
	if (!isRecord(value)) {
		return {};
	}

	const result: Record<string, { error: string; disabledAt: number }> = {};
	for (const [credentialId, entry] of Object.entries(value)) {
		if (!isRecord(entry)) {
			continue;
		}
		const error = typeof entry.error === "string" ? entry.error.trim() : "";
		const disabledAt =
			typeof entry.disabledAt === "number" && Number.isFinite(entry.disabledAt)
				? entry.disabledAt
				: Date.now();
		if (error) {
			result[credentialId] = { error, disabledAt };
		}
	}
	return result;
}

function parseCascadeState(value: unknown): ProviderRotationState["cascadeState"] {
	if (!isRecord(value)) {
		return undefined;
	}

	const cascadeState: NonNullable<ProviderRotationState["cascadeState"]> = {};
	for (const [providerId, providerState] of Object.entries(value)) {
		if (!isRecord(providerState)) {
			continue;
		}

		cascadeState[providerId] = JSON.parse(
			JSON.stringify({
				active: providerState.active,
				history: Array.isArray(providerState.history) ? providerState.history : [],
			}),
		) as NonNullable<ProviderRotationState["cascadeState"]>[string];
	}

	return Object.keys(cascadeState).length > 0 ? cascadeState : undefined;
}

function parseHealthState(value: unknown): ProviderRotationState["healthState"] {
	if (!isRecord(value)) {
		return undefined;
	}

	return JSON.parse(
		JSON.stringify({
			scores: isRecord(value.scores) ? value.scores : {},
			history: isRecord(value.history) ? value.history : undefined,
			configHash: typeof value.configHash === "string" ? value.configHash : undefined,
		}),
	) as ProviderRotationState["healthState"];
}

function parsePools(value: unknown): ProviderRotationState["pools"] {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const pools = value
		.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		.map((entry) => ({
			poolId: typeof entry.poolId === "string" ? entry.poolId.trim() : "",
			displayName: typeof entry.displayName === "string" ? entry.displayName.trim() : undefined,
			credentialIds: Array.isArray(entry.credentialIds)
				? entry.credentialIds.filter((item): item is string => typeof item === "string")
				: [],
			priority:
				typeof entry.priority === "number" && Number.isFinite(entry.priority)
					? entry.priority
					: 0,
			poolMode:
				(entry.poolMode === "usage-based" || entry.poolMode === "balancer"
					? entry.poolMode
					: "round-robin") as RotationMode,
			maxConcurrent:
				typeof entry.maxConcurrent === "number" && Number.isFinite(entry.maxConcurrent)
					? entry.maxConcurrent
					: undefined,
			healthThreshold:
				typeof entry.healthThreshold === "number" && Number.isFinite(entry.healthThreshold)
					? entry.healthThreshold
					: undefined,
			config: isRecord(entry.config)
				? {
					cooldownMs:
						typeof entry.config.cooldownMs === "number" && Number.isFinite(entry.config.cooldownMs)
							? entry.config.cooldownMs
							: undefined,
					backoffMultiplier:
						typeof entry.config.backoffMultiplier === "number" &&
						Number.isFinite(entry.config.backoffMultiplier)
							? entry.config.backoffMultiplier
							: undefined,
				}
				: undefined,
		}))
		.filter((pool) => pool.poolId.length > 0 && pool.credentialIds.length > 0);

	return pools.length > 0 ? pools : undefined;
}

function parsePoolConfig(value: unknown): ProviderRotationState["poolConfig"] {
	if (!isRecord(value)) {
		return undefined;
	}

	const failoverStrategy =
		value.failoverStrategy === "round-robin" ||
		value.failoverStrategy === "health-based" ||
		value.failoverStrategy === "priority"
			? value.failoverStrategy
			: DEFAULT_PROVIDER_POOL_CONFIG.failoverStrategy;
	const enablePools = typeof value.enablePools === "boolean"
		? value.enablePools
		: DEFAULT_PROVIDER_POOL_CONFIG.enablePools;
	const preferHealthyWithinPool = typeof value.preferHealthyWithinPool === "boolean"
		? value.preferHealthyWithinPool
		: DEFAULT_PROVIDER_POOL_CONFIG.preferHealthyWithinPool;

	const config: ProviderPoolConfig = {
		enablePools,
		failoverStrategy,
		preferHealthyWithinPool,
	};

	return JSON.stringify(config) === JSON.stringify(DEFAULT_PROVIDER_POOL_CONFIG)
		? undefined
		: config;
}

function parsePoolState(value: unknown): ProviderRotationState["poolState"] {
	if (!isRecord(value)) {
		return undefined;
	}

	const activePoolId = typeof value.activePoolId === "string" ? value.activePoolId.trim() : "";
	const poolIndex =
		typeof value.poolIndex === "number" && Number.isInteger(value.poolIndex) && value.poolIndex >= 0
			? value.poolIndex
			: undefined;
	if (!activePoolId && poolIndex === undefined) {
		return undefined;
	}
	return {
		activePoolId: activePoolId || undefined,
		poolIndex,
	};
}

function parseChains(value: unknown): ProviderRotationState["chains"] {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const chains = value
		.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		.map((entry) => ({
			chainId: typeof entry.chainId === "string" ? entry.chainId.trim() : "",
			displayName: typeof entry.displayName === "string" ? entry.displayName.trim() : undefined,
			providers: Array.isArray(entry.providers)
				? entry.providers
						.filter((provider): provider is Record<string, unknown> => isRecord(provider))
						.map((provider) => ({
							providerId:
								typeof provider.providerId === "string" ? provider.providerId.trim() : "",
							modelMapping: isRecord(provider.modelMapping)
								? Object.fromEntries(
										Object.entries(provider.modelMapping).filter(
											(entry): entry is [string, string] => typeof entry[1] === "string",
										),
								)
								: undefined,
							healthThreshold:
								typeof provider.healthThreshold === "number" && Number.isFinite(provider.healthThreshold)
									? provider.healthThreshold
									: undefined,
							maxAttempts:
								typeof provider.maxAttempts === "number" && Number.isFinite(provider.maxAttempts)
									? provider.maxAttempts
									: undefined,
						}))
						.filter((provider) => provider.providerId.length > 0)
				: [],
			maxAttemptsPerProvider:
				typeof entry.maxAttemptsPerProvider === "number" &&
				Number.isFinite(entry.maxAttemptsPerProvider)
					? entry.maxAttemptsPerProvider
					: 1,
			failoverTriggers: (Array.isArray(entry.failoverTriggers)
				? entry.failoverTriggers.filter((trigger): trigger is string => typeof trigger === "string")
				: []) as NonNullable<ProviderRotationState["chains"]>[number]["failoverTriggers"],
			modelMapping: isRecord(entry.modelMapping)
				? Object.fromEntries(
						Object.entries(entry.modelMapping)
							.filter((modelEntry): modelEntry is [string, Record<string, string>] =>
								isRecord(modelEntry[1]),
							)
							.map(([modelId, mapping]) => [
								modelId,
								Object.fromEntries(
									Object.entries(mapping).filter(
										(entry): entry is [string, string] => typeof entry[1] === "string",
									),
								),
							]),
					)
				: undefined,
		}))
		.filter((chain) => chain.chainId.length > 0 && chain.providers.length > 1);

	return chains.length > 0 ? chains : undefined;
}

function parseActiveChain(value: unknown): ProviderRotationState["activeChain"] {
	if (!isRecord(value)) {
		return undefined;
	}

	const chainId = typeof value.chainId === "string" ? value.chainId.trim() : "";
	const currentProviderId =
		typeof value.currentProviderId === "string" ? value.currentProviderId.trim() : "";
	if (!chainId || !currentProviderId) {
		return undefined;
	}

	return {
		chainId,
		position:
			typeof value.position === "number" && Number.isInteger(value.position) && value.position >= 0
				? value.position
				: 0,
		currentProviderId,
		attemptsOnCurrentProvider:
			typeof value.attemptsOnCurrentProvider === "number" &&
			Number.isInteger(value.attemptsOnCurrentProvider) &&
			value.attemptsOnCurrentProvider >= 0
				? value.attemptsOnCurrentProvider
				: 0,
		failoverReason: typeof value.failoverReason === "string" ? value.failoverReason : "unknown",
		failoverStartedAt:
			typeof value.failoverStartedAt === "number" && Number.isFinite(value.failoverStartedAt)
				? value.failoverStartedAt
				: Date.now(),
		failedProviders: Array.isArray(value.failedProviders)
			? value.failedProviders
					.filter((entry): entry is Record<string, unknown> => isRecord(entry))
					.map((entry) => ({
						providerId: typeof entry.providerId === "string" ? entry.providerId.trim() : "",
						failedAt:
							typeof entry.failedAt === "number" && Number.isFinite(entry.failedAt)
								? entry.failedAt
								: Date.now(),
						reason: typeof entry.reason === "string" ? entry.reason : "",
						errorKind:
							(typeof entry.errorKind === "string" ? entry.errorKind : "unknown") as NonNullable<
								ProviderRotationState["activeChain"]
							>["failedProviders"][number]["errorKind"],
					}))
					.filter((entry) => entry.providerId.length > 0)
			: [],
	};
}

function parseQuotaStates(value: unknown): ProviderRotationState["quotaStates"] {
	if (!isRecord(value)) {
		return undefined;
	}

	const result: NonNullable<ProviderRotationState["quotaStates"]> = {};
	for (const [credentialId, state] of Object.entries(value)) {
		if (!isRecord(state)) {
			continue;
		}
		const classification =
			typeof state.classification === "string" ? state.classification.trim() : "unknown";
		const errorMessage = typeof state.errorMessage === "string" ? state.errorMessage.trim() : "";
		const recoveryAction = isRecord(state.recoveryAction)
			? {
				action:
					(typeof state.recoveryAction.action === "string"
						? state.recoveryAction.action
						: "switch_credential") as NonNullable<
							ProviderRotationState["quotaStates"]
						>[string]["recoveryAction"]["action"],
				requiresManual: state.recoveryAction.requiresManual === true,
				estimatedWaitMs:
					typeof state.recoveryAction.estimatedWaitMs === "number" &&
					Number.isFinite(state.recoveryAction.estimatedWaitMs)
						? state.recoveryAction.estimatedWaitMs
						: undefined,
				description:
					typeof state.recoveryAction.description === "string"
						? state.recoveryAction.description
						: "Try another credential or provider.",
			}
			: undefined;
		if (!errorMessage || !recoveryAction) {
			continue;
		}
		result[credentialId] = {
			credentialId,
			classification: classification as NonNullable<ProviderRotationState["quotaStates"]>[string]["classification"],
			detectedAt:
				typeof state.detectedAt === "number" && Number.isFinite(state.detectedAt)
					? state.detectedAt
					: Date.now(),
			resetAt:
				typeof state.resetAt === "number" && Number.isFinite(state.resetAt)
					? state.resetAt
					: undefined,
			errorMessage,
			recoveryAction,
		};
	}

	return Object.keys(result).length > 0 ? result : undefined;
}

function parseNumberMap(value: unknown): Record<string, number> {
	if (!isRecord(value)) {
		return {};
	}

	const result: Record<string, number> = {};
	for (const [key, maybeNumber] of Object.entries(value)) {
		if (typeof maybeNumber === "number" && Number.isFinite(maybeNumber)) {
			result[key] = maybeNumber;
		}
	}
	return result;
}

function parseStringMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) {
		return {};
	}

	const result: Record<string, string> = {};
	for (const [key, maybeString] of Object.entries(value)) {
		if (typeof maybeString !== "string") {
			continue;
		}
		const normalized = maybeString.trim();
		if (!normalized) {
			continue;
		}
		result[key] = normalized;
	}
	return result;
}

function parseHiddenProviders(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const hiddenProviders: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			continue;
		}
		const normalized = entry.trim();
		if (!normalized || hiddenProviders.includes(normalized)) {
			continue;
		}
		hiddenProviders.push(normalized);
	}

	return hiddenProviders;
}

function parseState(content: string | undefined): MultiAuthState {
	if (!content || content.trim() === "") {
		return createDefaultMultiAuthState();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(
			`Invalid JSON in multi-auth.json: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!isRecord(parsed)) {
		return createDefaultMultiAuthState();
	}

	const providersRaw = isRecord(parsed.providers) ? parsed.providers : {};
	const uiRaw = isRecord(parsed.ui) ? parsed.ui : {};
	const state = createDefaultMultiAuthState();

	for (const [providerId, providerValue] of Object.entries(providersRaw)) {
		state.providers[providerId] = parseProviderState(providerId as SupportedProviderId, providerValue);
	}
	state.ui.hiddenProviders = parseHiddenProviders(uiRaw.hiddenProviders);

	return state;
}

function isRetryableStorageSnapshotError(error: Error): boolean {
	return error.message.startsWith("Invalid JSON in multi-auth.json:") || isRetryableFileAccessError(error);
}

async function readMultiAuthStateSnapshot(storagePath: string): Promise<MultiAuthState> {
	return readTextSnapshotWithRetries({
		filePath: storagePath,
		failureMessage: `Failed to read multi-auth.json snapshot from '${storagePath}'.`,
		read: async () => ((await pathExists(storagePath)) ? readFile(storagePath, "utf-8") : undefined),
		parse: parseState,
		resolveOnFinalEmpty: () => createDefaultMultiAuthState(),
		isRetryableError: isRetryableStorageSnapshotError,
	});
}

function serializeState(state: MultiAuthState): string {
	return JSON.stringify(state, null, 2);
}

function createStorageFingerprint(fileStats: { mtimeMs: number; size: number }): string {
	return `${Math.round(fileStats.mtimeMs)}:${fileStats.size}`;
}

async function writeSerializedMultiAuthStateSnapshot(
	storagePath: string,
	serializedState: string,
): Promise<void> {
	await writeTextSnapshotWithRetries({
		filePath: storagePath,
		failureMessage: `Failed to persist multi-auth.json to '${storagePath}'.`,
		write: async () => {
			await writeFile(storagePath, serializedState, "utf-8");
			await chmod(storagePath, 0o600);
		},
		isRetryableError: isRetryableFileAccessError,
	});
}

function cloneState(state: MultiAuthState): MultiAuthState {
	const providers: Record<string, ProviderRotationState> = {};
	for (const [provider, providerState] of Object.entries(state.providers)) {
		providers[provider] = cloneProviderState(providerState);
	}

	return {
		version: 1,
		providers,
		ui: {
			hiddenProviders: [...state.ui.hiddenProviders],
		},
	};
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

function buildProviderCredentialIndex(
	state: MultiAuthState,
): Map<string, SupportedProviderId> {
	const providerByCredentialId = new Map<string, SupportedProviderId>();
	for (const [providerId, providerState] of Object.entries(state.providers)) {
		for (const credentialId of providerState.credentialIds) {
			providerByCredentialId.set(credentialId, providerId as SupportedProviderId);
		}
	}
	return providerByCredentialId;
}

/**
 * Persistence layer for the active agent runtime multi-auth.json file with file locking.
 */
export class MultiAuthStorage {
	private cachedState: MultiAuthState | null = null;
	private cachedFingerprint: string | null = null;
	private cachedSerializedState: string | null = null;
	private cachedProviderByCredentialId = new Map<string, SupportedProviderId>();
	private readonly readLatencyMs = new RollingMetricSeries();
	private readonly writeLatencyMs = new RollingMetricSeries();
	private readonly lockAcquisitionLatencyMs = new RollingMetricSeries();
	private readonly statePayloadBytes = new RollingMetricSeries();
	private cacheHitCount = 0;
	private cacheMissCount = 0;
	private lockRetryCount = 0;
	private lastKnownStateSizeBytes = 0;
	private readonly historyStore: MultiAuthHistoryStore;
	private readonly storagePath: string;

	constructor(storagePath: string = getDefaultMultiAuthPath(), options: MultiAuthStorageOptions = {}) {
		this.storagePath = storagePath;
		const defaultDebugDir =
			storagePath === getDefaultMultiAuthPath() ? DEBUG_DIR : join(dirname(storagePath), "debug");
		this.historyStore = new MultiAuthHistoryStore({
			debugDir: options.debugDir ?? defaultDebugDir,
			historyPersistence: cloneHistoryPersistenceConfig(
				options.historyPersistence ?? DEFAULT_HISTORY_PERSISTENCE_CONFIG,
			),
		});
	}

	/**
	 * Returns the configured storage path.
	 */
	getPath(): string {
		return this.storagePath;
	}

	getMetrics(): MultiAuthStorageMetrics {
		const totalCacheReads = this.cacheHitCount + this.cacheMissCount;
		return {
			readLatencyMs: this.readLatencyMs.snapshot(),
			writeLatencyMs: this.writeLatencyMs.snapshot(),
			lockAcquisitionLatencyMs: this.lockAcquisitionLatencyMs.snapshot(),
			statePayloadBytes: this.statePayloadBytes.snapshot(),
			cacheHitCount: this.cacheHitCount,
			cacheMissCount: this.cacheMissCount,
			cacheHitRate:
				totalCacheReads === 0 ? 0 : Math.round((this.cacheHitCount / totalCacheReads) * 1000) / 1000,
			lockRetryCount: this.lockRetryCount,
			lastKnownStateSizeBytes: this.lastKnownStateSizeBytes,
		};
	}

	/**
	 * Reads the current pi-multi-auth state from an optimistic snapshot.
	 * Snapshot retries tolerate concurrent writes without taking the extension lock.
	 */
	async read(): Promise<MultiAuthState> {
		await this.ensureStorageReady();
		const snapshot = await this.readCachedSnapshotReference();
		return cloneState(snapshot.state);
	}

	/**
	 * Reads one provider state without cloning the full multi-auth document.
	 */
	async readProviderState(provider: SupportedProviderId): Promise<ProviderRotationState> {
		await this.ensureStorageReady();
		const snapshot = await this.readCachedSnapshotReference();
		const providerState = snapshot.state.providers[provider];
		return providerState
			? cloneProviderState(providerState)
			: createEmptyProviderState(resolveDefaultRotationMode(provider));
	}

	/**
	 * Resolves the provider that owns one credential from the cached storage snapshot.
	 */
	async findProviderForCredential(credentialId: string): Promise<SupportedProviderId | null> {
		const normalizedCredentialId = credentialId.trim();
		if (normalizedCredentialId.length === 0) {
			return null;
		}

		await this.ensureStorageReady();
		await this.readCachedSnapshotReference();
		return this.cachedProviderByCredentialId.get(normalizedCredentialId) ?? null;
	}

	/**
	 * Executes a read-modify-write transaction under lock.
	 */
	async withLock<T>(
		fn: (state: MultiAuthState) => Promise<LockResult<T>> | LockResult<T>,
	): Promise<T> {
		await this.ensureStorageReady();

		let release: (() => Promise<void>) | undefined;

		try {
			release = await acquireFileLock(
				this.storagePath,
				{
					realpath: false,
					retries: {
						retries: 10,
						factor: 2,
						minTimeout: 100,
						maxTimeout: 10_000,
						randomize: true,
					},
					stale: 30_000,
					onCompromised: () => {
						// Stale lock cleanup happened; continue transaction under the new lock.
					},
				},
				{
					onRetry: () => {
						this.lockRetryCount += 1;
					},
					onAcquired: (latencyMs) => {
						this.lockAcquisitionLatencyMs.record(latencyMs);
					},
				},
			);

			const snapshot = await this.readCachedSnapshotReference();
			const result = await fn(cloneState(snapshot.state));

			if (result.next) {
				const serializedNext = serializeState(result.next);
				if (serializedNext !== snapshot.serializedState) {
					await this.persistSerializedState(result.next, serializedNext);
				} else {
					this.updateCache(snapshot.state, snapshot.fingerprint, snapshot.serializedState);
				}
			} else {
				this.updateCache(snapshot.state, snapshot.fingerprint, snapshot.serializedState);
			}
			return result.result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock failures when compromised.
				}
			}
		}
	}

	private async ensureStorageReady(): Promise<void> {
		await ensureParentDir(this.storagePath);
		await ensureFileExists(this.storagePath);
	}

	private async readCachedSnapshotReference(): Promise<CachedStorageSnapshot> {
		const startedAt = Date.now();
		const fileStats = await stat(this.storagePath);
		const fingerprint = await this.buildSnapshotFingerprint(fileStats);
		this.lastKnownStateSizeBytes = fileStats.size;
		this.statePayloadBytes.record(fileStats.size);
		if (
			this.cachedState &&
			this.cachedFingerprint === fingerprint &&
			this.cachedSerializedState !== null
		) {
			this.cacheHitCount += 1;
			this.readLatencyMs.record(Date.now() - startedAt);
			return {
				state: this.cachedState,
				fingerprint,
				serializedState: this.cachedSerializedState,
			};
		}

		this.cacheMissCount += 1;
		const parsed = await readMultiAuthStateSnapshot(this.storagePath);
		const hydrated = await this.historyStore.hydrateState(parsed);
		const serializedState = serializeState(hydrated);
		this.updateCache(hydrated, fingerprint, serializedState, fileStats.size);
		this.readLatencyMs.record(Date.now() - startedAt);
		return {
			state: this.cachedState ?? cloneState(hydrated),
			fingerprint,
			serializedState,
		};
	}

	private async persistSerializedState(
		state: MultiAuthState,
		serializedState: string,
	): Promise<void> {
		const startedAt = Date.now();
		const persistedState = await this.historyStore.createPersistedState(cloneState(state));
		const persistedSerializedState = serializeState(persistedState);
		await writeSerializedMultiAuthStateSnapshot(this.storagePath, persistedSerializedState);
		const fileStats = await stat(this.storagePath);
		const fingerprint = await this.buildSnapshotFingerprint(fileStats);
		this.writeLatencyMs.record(Date.now() - startedAt);
		this.updateCache(state, fingerprint, serializedState, fileStats.size);
	}

	private async buildSnapshotFingerprint(fileStats: { mtimeMs: number; size: number }): Promise<string> {
		const storageFingerprint = createStorageFingerprint(fileStats);
		const historyFingerprint = await this.historyStore.createFingerprint();
		return historyFingerprint ? `${storageFingerprint}|${historyFingerprint}` : storageFingerprint;
	}

	private updateCache(
		state: MultiAuthState,
		fingerprint: string | null,
		serializedState: string,
		persistedSizeBytes?: number,
	): void {
		const cachedState = cloneState(state);
		this.cachedState = cachedState;
		this.cachedFingerprint = fingerprint;
		this.cachedSerializedState = serializedState;
		this.cachedProviderByCredentialId = buildProviderCredentialIndex(cachedState);
		const sizeBytes = persistedSizeBytes ?? Buffer.byteLength(serializedState, "utf-8");
		this.lastKnownStateSizeBytes = sizeBytes;
		this.statePayloadBytes.record(sizeBytes);
	}
}

/**
 * Ensures a provider state exists and returns it.
 */
export function getProviderState(
	state: MultiAuthState,
	provider: SupportedProviderId,
): ProviderRotationState {
	const providerState = state.providers[provider];
	if (!providerState) {
		state.providers[provider] = createEmptyProviderState(resolveDefaultRotationMode(provider));
		return state.providers[provider];
	}
	return providerState;
}
