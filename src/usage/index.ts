import { createHash } from "node:crypto";
import { getErrorMessage } from "../auth-error-utils.js";
import { usageProviders } from "./providers.js";
import {
	UsageSnapshotCacheStore,
	type UsageCacheHydrationOptions,
	type UsageCachePersistenceOptions,
	type UsageCacheRecord,
	type UsageDisplayCacheRecord,
} from "./persistent-cache.js";
import { UsageCoordinator, type UsageCoordinationOperation } from "./usage-coordinator.js";
import type {
	UsageAuth,
	UsageFetchOptions,
	UsageFetchResult,
	UsageProvider,
	UsageSnapshot,
} from "./types.js";

const DEFAULT_USAGE_FRESH_TTL_MS = 30_000;
const DEFAULT_USAGE_STALE_TTL_MS = 5 * 60_000;
const DEFAULT_USAGE_ERROR_TTL_MS = 10_000;
const DEFAULT_USAGE_AUTH_ERROR_TTL_MS = 3_000;
const MIN_SUCCESS_FRESH_TTL_MS = 5_000;

interface UsageCacheEntry {
	result: Omit<UsageFetchResult, "fromCache">;
	freshUntil: number;
	staleUntil: number;
}

interface UsageDisplayCacheEntry {
	result: Omit<UsageFetchResult, "fromCache">;
	displayUntil: number;
}

interface ResolvedUsageCacheRead {
	result: UsageFetchResult;
	isStale: boolean;
}

export interface UsageServiceOptions {
	persistentCache?: UsageSnapshotCacheStore | UsageCachePersistenceOptions | false;
}

class UsageFetchCompletedWithError extends Error {
	constructor(readonly result: Omit<UsageFetchResult, "fromCache">) {
		super(result.error ?? "Usage unavailable");
		this.name = "UsageFetchCompletedWithError";
	}
}

function normalizeCredentialCacheComponent(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function getCredentialRecordString(
	credential: Record<string, unknown> | undefined,
	key: string,
): string | null {
	return normalizeCredentialCacheComponent(credential?.[key]);
}

function digestUsageCacheComponent(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function createUsageCredentialCacheKey(
	providerId: string,
	credentialId: string,
	auth?: UsageAuth,
): string {
	const accountId =
		normalizeCredentialCacheComponent(auth?.accountId) ??
		getCredentialRecordString(auth?.credential, "accountId");
	const credentialProvider = getCredentialRecordString(auth?.credential, "provider");
	const secretDigest = auth?.accessToken
		? digestUsageCacheComponent(auth.accessToken).slice(0, 32)
		: null;
	return `v1:${digestUsageCacheComponent(JSON.stringify({
		providerId,
		credentialId,
		accountId,
		credentialProvider,
		secretDigest,
	}))}`;
}

function providerCredentialIndexKey(providerId: string, credentialId: string): string {
	return `${providerId}\u0000${credentialId}`;
}

function cacheKey(providerId: string, credentialId: string, credentialCacheKey: string): string {
	return `${providerId}\u0000${credentialId}\u0000${credentialCacheKey}`;
}

function isFinitePositiveNumber(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function getSoonestResetAt(snapshot: UsageSnapshot | null): number | null {
	if (!snapshot) {
		return null;
	}

	const candidates = [
		snapshot.primary?.resetsAt,
		snapshot.secondary?.resetsAt,
		snapshot.copilotQuota?.resetAt,
		snapshot.estimatedResetAt,
		snapshot.rateLimitHeaders?.resetAt,
	].filter((value): value is number => typeof value === "number" && Number.isFinite(value));

	if (candidates.length === 0) {
		return null;
	}

	return Math.min(...candidates);
}

function isAuthLikeUsageError(message: string): boolean {
	return /\b401\b|\b403\b|expired|invalid|denied|missing required usage scope|token/i.test(
		message,
	);
}

function createPersistentCacheStore(
	options: UsageServiceOptions,
): UsageSnapshotCacheStore | undefined {
	if (options.persistentCache === false) {
		return undefined;
	}
	if (options.persistentCache instanceof UsageSnapshotCacheStore) {
		return options.persistentCache;
	}
	return new UsageSnapshotCacheStore(options.persistentCache);
}

/**
 * Orchestrates provider-specific usage fetching with single-flight in-memory cache.
 */
export class UsageService {
	private readonly providers = new Map<string, UsageProvider<UsageAuth>>();
	private readonly cache = new Map<string, UsageCacheEntry>();
	private readonly cacheKeysByCredential = new Map<string, Set<string>>();
	private readonly displayCache = new Map<string, UsageDisplayCacheEntry>();
	private readonly displayCacheKeysByCredential = new Map<string, Set<string>>();
	private readonly preferredCredentialCacheKeys = new Map<string, string>();
	private readonly inFlight = new Map<string, Promise<Omit<UsageFetchResult, "fromCache">>>();
	private readonly persistentCacheStore?: UsageSnapshotCacheStore;

	constructor(
		private readonly freshTtlMs: number = DEFAULT_USAGE_FRESH_TTL_MS,
		private readonly staleTtlMs: number = DEFAULT_USAGE_STALE_TTL_MS,
		private readonly errorTtlMs: number = DEFAULT_USAGE_ERROR_TTL_MS,
		private usageCoordinator?: UsageCoordinator,
		options: UsageServiceOptions = {},
	) {
		this.persistentCacheStore = createPersistentCacheStore(options);
		for (const provider of usageProviders) {
			this.register(provider);
		}
	}

	/**
	 * Registers a usage provider implementation.
	 */
	register(provider: UsageProvider<UsageAuth>): void {
		this.providers.set(provider.id, provider);
	}

	/**
	 * Attaches the shared coordinator that admits only bounded fresh usage requests.
	 */
	setUsageCoordinator(usageCoordinator: UsageCoordinator): void {
		this.usageCoordinator = usageCoordinator;
	}

	/**
	 * Indicates whether a provider has a dedicated usage implementation.
	 */
	hasProvider(providerId: string): boolean {
		return this.providers.has(providerId);
	}

	/**
	 * Returns the persistent warm-start cache path, when persistence is enabled.
	 */
	getPersistentCachePath(): string | null {
		return this.persistentCacheStore?.getPath() ?? null;
	}

	/**
	 * Hydrates non-expired persisted usage snapshots into the non-authoritative in-memory cache.
	 */
	async hydratePersistedCache(options: UsageCacheHydrationOptions = {}): Promise<void> {
		if (!this.persistentCacheStore) {
			return;
		}
		const { operationalEntries, displayEntries } = await this.persistentCacheStore.readHydrationEntries(
			Date.now(),
			options,
		);
		for (const entry of operationalEntries) {
			this.setCacheEntry(
				entry.providerId,
				entry.credentialId,
				entry.credentialCacheKey,
				{
					result: entry.result,
					freshUntil: entry.freshUntil,
					staleUntil: entry.staleUntil,
				},
			);
		}
		for (const entry of displayEntries) {
			this.setDisplayCacheEntry(entry);
		}
	}

	/**
	 * Registers the currently active credential material for one provider credential pair.
	 * This lets auth-aware callers prefer the matching cache record when historical entries exist.
	 */
	setPreferredCredentialCacheKey(
		providerId: string,
		credentialId: string,
		credentialCacheKey: string | null,
	): void {
		const indexKey = providerCredentialIndexKey(providerId, credentialId);
		if (!credentialCacheKey) {
			this.preferredCredentialCacheKeys.delete(indexKey);
			return;
		}
		this.preferredCredentialCacheKeys.set(indexKey, cacheKey(providerId, credentialId, credentialCacheKey));
	}

	/**
	 * Clears cache for one credential.
	 */
	clearCredential(providerId: string, credentialId: string): void {
		this.clearIndexedCache(providerId, credentialId, this.cache, this.cacheKeysByCredential, true);
		this.clearIndexedCache(providerId, credentialId, this.displayCache, this.displayCacheKeysByCredential);
		this.preferredCredentialCacheKeys.delete(providerCredentialIndexKey(providerId, credentialId));
	}

	/**
	 * Clears all cached snapshots for a provider.
	 */
	clearProvider(providerId: string): void {
		this.clearIndexedCacheProvider(providerId, this.cache, this.cacheKeysByCredential, true);
		this.clearIndexedCacheProvider(providerId, this.displayCache, this.displayCacheKeysByCredential);
		for (const indexKey of [...this.preferredCredentialCacheKeys.keys()]) {
			if (indexKey.startsWith(`${providerId} `)) {
				this.preferredCredentialCacheKeys.delete(indexKey);
			}
		}
	}


	/**
	 * Reads a cached usage snapshot without triggering a provider fetch.
	 */
	readCachedUsage(
		providerId: string,
		credentialId: string,
		options: UsageFetchOptions = {},
	): UsageFetchResult | null {
		return this.resolveCachedReadForCredential(providerId, credentialId, options, Date.now())?.result ?? null;
	}

	/**
	 * Reads a display-only last-known usage snapshot without exposing it to operational decisions.
	 */
	readDisplayUsage(providerId: string, credentialId: string): UsageFetchResult | null {
		return this.resolveDisplayReadForCredential(providerId, credentialId, Date.now());
	}

	/**
	 * Fetches usage snapshot with cache, request de-duplication, and coordinated fresh calls.
	 */
	async fetchUsage(
		providerId: string,
		credentialId: string,
		auth: UsageAuth,
		options: UsageFetchOptions = {},
	): Promise<UsageFetchResult> {
		const credentialCacheKey = createUsageCredentialCacheKey(providerId, credentialId, auth);
		const key = cacheKey(providerId, credentialId, credentialCacheKey);
		const resolvedCachedRead = this.resolveCachedRead(key, options, Date.now());
		if (resolvedCachedRead && !resolvedCachedRead.isStale) {
			return resolvedCachedRead.result;
		}

		const staleCandidate = resolvedCachedRead?.isStale ? resolvedCachedRead.result : undefined;
		const existingInFlight = this.inFlight.get(key);
		if (existingInFlight) {
			if (staleCandidate) {
				return staleCandidate;
			}

			const result = await existingInFlight;
			return {
				...result,
				fromCache: false,
			};
		}

		const fetchPromise = this.fetchFreshUsage(
			providerId,
			credentialId,
			auth,
			key,
			credentialCacheKey,
			options.coordinationOperation ?? "direct",
		);
		this.inFlight.set(key, fetchPromise);

		const settledFetch = fetchPromise.finally(() => {
			if (this.inFlight.get(key) === fetchPromise) {
				this.inFlight.delete(key);
			}
		});

		if (staleCandidate) {
			void settledFetch.catch(() => undefined);
			return staleCandidate;
		}

		const result = await settledFetch;
		return {
			...result,
			fromCache: false,
		};
	}


	private setCacheEntry(
		providerId: string,
		credentialId: string,
		credentialCacheKey: string,
		entry: UsageCacheEntry,
	): void {
		const key = cacheKey(providerId, credentialId, credentialCacheKey);
		this.cache.set(key, entry);
		this.setCacheIndex(providerId, credentialId, key, this.cacheKeysByCredential);
	}

	private setDisplayCacheEntry(entry: UsageDisplayCacheRecord): void {
		const key = cacheKey(entry.providerId, entry.credentialId, entry.credentialCacheKey);
		this.displayCache.set(key, {
			result: entry.result,
			displayUntil: entry.displayUntil,
		});
		this.setCacheIndex(entry.providerId, entry.credentialId, key, this.displayCacheKeysByCredential);
	}

	private setCacheIndex(
		providerId: string,
		credentialId: string,
		key: string,
		index: Map<string, Set<string>>,
	): void {
		const indexKey = providerCredentialIndexKey(providerId, credentialId);
		const keys = index.get(indexKey) ?? new Set<string>();
		keys.add(key);
		index.set(indexKey, keys);
	}

	private clearIndexedCache<TEntry>(
		providerId: string,
		credentialId: string,
		cache: Map<string, TEntry>,
		index: Map<string, Set<string>>,
		deleteInFlight: boolean = false,
	): void {
		const indexKey = providerCredentialIndexKey(providerId, credentialId);
		const keys = index.get(indexKey);
		if (!keys) {
			return;
		}
		for (const key of keys) {
			cache.delete(key);
			if (deleteInFlight) {
				this.inFlight.delete(key);
			}
		}
		index.delete(indexKey);
	}

	private clearIndexedCacheProvider<TEntry>(
		providerId: string,
		cache: Map<string, TEntry>,
		index: Map<string, Set<string>>,
		deleteInFlight: boolean = false,
	): void {
		const indexPrefix = `${providerId}\u0000`;
		for (const [indexKey, keys] of index.entries()) {
			if (!indexKey.startsWith(indexPrefix)) {
				continue;
			}
			for (const key of keys) {
				cache.delete(key);
				if (deleteInFlight) {
					this.inFlight.delete(key);
				}
			}
			index.delete(indexKey);
		}
	}

	private resolvePreferredCachedRead(
		providerId: string,
		credentialId: string,
		options: UsageFetchOptions,
		now: number,
	): ResolvedUsageCacheRead | null {
		const preferredKey = this.preferredCredentialCacheKeys.get(
			providerCredentialIndexKey(providerId, credentialId),
		);
		return preferredKey ? this.resolveCachedRead(preferredKey, options, now) : null;
	}

	private resolvePreferredDisplayRead(
		providerId: string,
		credentialId: string,
		now: number,
	): UsageFetchResult | null {
		const preferredKey = this.preferredCredentialCacheKeys.get(
			providerCredentialIndexKey(providerId, credentialId),
		);
		if (!preferredKey) {
			return null;
		}

		const entry = this.displayCache.get(preferredKey);
		if (!entry || entry.displayUntil <= now || !entry.result.snapshot) {
			return null;
		}

		return {
			...entry.result,
			fromCache: true,
		};
	}

	private resolveCachedReadForCredential(
		providerId: string,
		credentialId: string,
		options: UsageFetchOptions,
		now: number,
	): ResolvedUsageCacheRead | null {
		const preferredRead = this.resolvePreferredCachedRead(providerId, credentialId, options, now);
		if (preferredRead) {
			return preferredRead;
		}

		const keys = this.cacheKeysByCredential.get(providerCredentialIndexKey(providerId, credentialId));
		if (!keys || keys.size === 0) {
			return null;
		}

		let selected: ResolvedUsageCacheRead | null = null;
		let selectedKey: string | null = null;
		for (const key of keys) {
			const read = this.resolveCachedRead(key, options, now);
			if (!read) {
				continue;
			}
			if (selected && selectedKey !== key) {
				return null;
			}
			selected = read;
			selectedKey = key;
		}

		return selected;
	}

	private resolveDisplayReadForCredential(
		providerId: string,
		credentialId: string,
		now: number,
	): UsageFetchResult | null {
		const preferredRead = this.resolvePreferredDisplayRead(providerId, credentialId, now);
		if (preferredRead) {
			return preferredRead;
		}

		const keys = this.displayCacheKeysByCredential.get(providerCredentialIndexKey(providerId, credentialId));
		if (!keys || keys.size === 0) {
			return null;
		}

		let selected: UsageFetchResult | null = null;
		let selectedKey: string | null = null;
		for (const key of keys) {
			const entry = this.displayCache.get(key);
			if (!entry || entry.displayUntil <= now || !entry.result.snapshot) {
				continue;
			}
			if (selected && selectedKey !== key) {
				return null;
			}
			selected = {
				...entry.result,
				fromCache: true,
			};
			selectedKey = key;
		}

		return selected;
	}

	private resolveCachedRead(
		key: string,
		options: UsageFetchOptions,
		now: number,
	): ResolvedUsageCacheRead | null {
		if (options.forceRefresh) {
			return null;
		}

		const cached = this.cache.get(key);
		if (!cached) {
			return null;
		}

		const maxAgeMs = isFinitePositiveNumber(options.maxAgeMs) ? options.maxAgeMs : undefined;
		if (this.isEntryFresh(cached, now, maxAgeMs)) {
			return {
				result: {
					...cached.result,
					fromCache: true,
				},
				isStale: false,
			};
		}

		if (!options.allowStale) {
			return null;
		}

		const staleCandidate = this.getStaleCandidate(cached, now, maxAgeMs);
		if (!staleCandidate) {
			return null;
		}

		return {
			result: {
				...staleCandidate.result,
				fromCache: true,
			},
			isStale: true,
		};
	}

	private isEntryFresh(entry: UsageCacheEntry, now: number, maxAgeMs?: number): boolean {
		if (entry.freshUntil <= now) {
			return false;
		}

		if (maxAgeMs === undefined) {
			return true;
		}

		return now - entry.result.fetchedAt <= maxAgeMs;
	}

	private getStaleCandidate(
		entry: UsageCacheEntry | undefined,
		now: number,
		maxAgeMs?: number,
	): UsageCacheEntry | undefined {
		if (!entry) {
			return undefined;
		}

		if (entry.staleUntil <= now) {
			return undefined;
		}

		if (entry.result.snapshot === null) {
			return undefined;
		}

		if (maxAgeMs !== undefined && now - entry.result.fetchedAt > maxAgeMs) {
			return undefined;
		}

		return entry;
	}

	private fetchFreshUsage(
		providerId: string,
		credentialId: string,
		auth: UsageAuth,
		key: string,
		credentialCacheKey: string,
		operation: UsageCoordinationOperation,
	): Promise<Omit<UsageFetchResult, "fromCache">> {
		const provider = this.providers.get(providerId);
		if (!this.usageCoordinator || !provider?.fetchUsage) {
			return this.fetchAndCache(providerId, credentialId, auth, key, credentialCacheKey);
		}

		return this.usageCoordinator
			.executeFreshRequest(
				{ provider: providerId, credentialId, operation },
				async () => {
					const result = await this.fetchAndCache(
						providerId,
						credentialId,
						auth,
						key,
						credentialCacheKey,
					);
					if (result.error) {
						throw new UsageFetchCompletedWithError(result);
					}
					return result;
				},
			)
			.catch((error: unknown) => {
				if (error instanceof UsageFetchCompletedWithError) {
					return error.result;
				}
				throw error;
			});
	}

	private async fetchAndCache(
		providerId: string,
		credentialId: string,
		auth: UsageAuth,
		key: string,
		credentialCacheKey: string,
	): Promise<Omit<UsageFetchResult, "fromCache">> {
		const provider = this.providers.get(providerId);
		if (!provider?.fetchUsage) {
			const fetchedAt = Date.now();
			const result: Omit<UsageFetchResult, "fromCache"> = {
				snapshot: null,
				error: "Usage unavailable",
				fetchedAt,
			};
			await this.cacheResult(providerId, credentialId, credentialCacheKey, result, true);
			return result;
		}

		try {
			const snapshot = await provider.fetchUsage(auth);
			const fetchedAt = Date.now();
			const result: Omit<UsageFetchResult, "fromCache"> = {
				snapshot,
				error: snapshot ? null : "Usage unavailable",
				fetchedAt,
			};
			await this.cacheResult(providerId, credentialId, credentialCacheKey, result, snapshot === null);
			return result;
		} catch (error: unknown) {
			const fetchedAt = Date.now();
			const message = getErrorMessage(error);
			const result: Omit<UsageFetchResult, "fromCache"> = {
				snapshot: null,
				error: `Usage unavailable (${message})`,
				fetchedAt,
			};
			await this.cacheResult(providerId, credentialId, credentialCacheKey, result, true, message);
			return result;
		}
	}

	private async cacheResult(
		providerId: string,
		credentialId: string,
		credentialCacheKey: string,
		result: Omit<UsageFetchResult, "fromCache">,
		isError: boolean,
		errorMessage?: string,
	): Promise<void> {
		const freshTtlMs = isError
			? this.resolveErrorTtlMs(errorMessage)
			: this.resolveSuccessFreshTtlMs(result.snapshot, result.fetchedAt);
		const staleTtlMs = isError ? freshTtlMs : Math.max(this.staleTtlMs, freshTtlMs);

		const entry: UsageCacheEntry = {
			result,
			freshUntil: result.fetchedAt + freshTtlMs,
			staleUntil: result.fetchedAt + staleTtlMs,
		};
		this.setCacheEntry(providerId, credentialId, credentialCacheKey, entry);

		if (!isError && result.snapshot && this.persistentCacheStore) {
			const persistentEntry: UsageCacheRecord = {
				providerId,
				credentialId,
				credentialCacheKey,
				result,
				freshUntil: entry.freshUntil,
				staleUntil: entry.staleUntil,
			};
			const displayEntry = await this.persistentCacheStore.persistSuccessfulEntry(
				persistentEntry,
				result.fetchedAt,
			);
			if (displayEntry) {
				this.setDisplayCacheEntry(displayEntry);
			}
		}
	}

	private resolveErrorTtlMs(errorMessage?: string): number {
		if (errorMessage && isAuthLikeUsageError(errorMessage)) {
			return DEFAULT_USAGE_AUTH_ERROR_TTL_MS;
		}
		return this.errorTtlMs;
	}

	private resolveSuccessFreshTtlMs(snapshot: UsageSnapshot | null, now: number): number {
		if (!snapshot) {
			return this.errorTtlMs;
		}

		const soonestResetAt = getSoonestResetAt(snapshot);
		if (soonestResetAt === null || soonestResetAt <= now) {
			return this.freshTtlMs;
		}

		const msUntilReset = soonestResetAt - now;
		if (msUntilReset <= MIN_SUCCESS_FRESH_TTL_MS) {
			return MIN_SUCCESS_FRESH_TTL_MS;
		}

		const adaptiveTtl = Math.floor(msUntilReset / 4);
		return Math.max(MIN_SUCCESS_FRESH_TTL_MS, Math.min(this.freshTtlMs, adaptiveTtl));
	}
}
