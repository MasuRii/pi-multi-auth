import { getErrorMessage } from "../auth-error-utils.js";
import { usageProviders } from "./providers.js";
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

interface ResolvedUsageCacheRead {
	result: UsageFetchResult;
	isStale: boolean;
}

function cacheKey(providerId: string, credentialId: string): string {
	return `${providerId}:${credentialId}`;
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

/**
 * Orchestrates provider-specific usage fetching with single-flight in-memory cache.
 */
export class UsageService {
	private readonly providers = new Map<string, UsageProvider<UsageAuth>>();
	private readonly cache = new Map<string, UsageCacheEntry>();
	private readonly inFlight = new Map<string, Promise<Omit<UsageFetchResult, "fromCache">>>();

	constructor(
		private readonly freshTtlMs: number = DEFAULT_USAGE_FRESH_TTL_MS,
		private readonly staleTtlMs: number = DEFAULT_USAGE_STALE_TTL_MS,
		private readonly errorTtlMs: number = DEFAULT_USAGE_ERROR_TTL_MS,
	) {
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
	 * Indicates whether a provider has a dedicated usage implementation.
	 */
	hasProvider(providerId: string): boolean {
		return this.providers.has(providerId);
	}

	/**
	 * Clears cache for one credential.
	 */
	clearCredential(providerId: string, credentialId: string): void {
		const key = cacheKey(providerId, credentialId);
		this.cache.delete(key);
	}

	/**
	 * Clears all cached snapshots for a provider.
	 */
	clearProvider(providerId: string): void {
		for (const key of this.cache.keys()) {
			if (key.startsWith(`${providerId}:`)) {
				this.cache.delete(key);
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
		const key = cacheKey(providerId, credentialId);
		return this.resolveCachedRead(key, options, Date.now())?.result ?? null;
	}

	/**
	 * Fetches usage snapshot with cache and request de-duplication.
	 */
	async fetchUsage(
		providerId: string,
		credentialId: string,
		auth: UsageAuth,
		options: UsageFetchOptions = {},
	): Promise<UsageFetchResult> {
		const key = cacheKey(providerId, credentialId);
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

		const fetchPromise = this.fetchAndCache(providerId, auth, key);
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

	private async fetchAndCache(
		providerId: string,
		auth: UsageAuth,
		key: string,
	): Promise<Omit<UsageFetchResult, "fromCache">> {
		const provider = this.providers.get(providerId);
		if (!provider?.fetchUsage) {
			const fetchedAt = Date.now();
			const result: Omit<UsageFetchResult, "fromCache"> = {
				snapshot: null,
				error: "Usage unavailable",
				fetchedAt,
			};
			this.cacheResult(key, result, true);
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
			this.cacheResult(key, result, snapshot === null);
			return result;
		} catch (error: unknown) {
			const fetchedAt = Date.now();
			const message = getErrorMessage(error);
			const result: Omit<UsageFetchResult, "fromCache"> = {
				snapshot: null,
				error: `Usage unavailable (${message})`,
				fetchedAt,
			};
			this.cacheResult(key, result, true, message);
			return result;
		}
	}

	private cacheResult(
		key: string,
		result: Omit<UsageFetchResult, "fromCache">,
		isError: boolean,
		errorMessage?: string,
	): void {
		const freshTtlMs = isError
			? this.resolveErrorTtlMs(errorMessage)
			: this.resolveSuccessFreshTtlMs(result.snapshot, result.fetchedAt);
		const staleTtlMs = isError ? freshTtlMs : Math.max(this.staleTtlMs, freshTtlMs);

		this.cache.set(key, {
			result,
			freshUntil: result.fetchedAt + freshTtlMs,
			staleUntil: result.fetchedAt + staleTtlMs,
		});
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
