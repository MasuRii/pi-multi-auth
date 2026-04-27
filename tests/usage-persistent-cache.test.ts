import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountManager } from "../src/account-manager.js";
import { AuthWriter } from "../src/auth-writer.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { MultiAuthStorage } from "../src/storage.js";
import { createUsageCredentialCacheKey, UsageService } from "../src/usage/index.js";
import {
	USAGE_CACHE_SCHEMA_VERSION,
	UsageSnapshotCacheStore,
	type UsageCacheRecord,
} from "../src/usage/persistent-cache.js";
import type { UsageAuth, UsageSnapshot } from "../src/usage/types.js";

interface PersistedUsageCacheTestFile {
	schemaVersion: number;
	generatedAt: number;
	maxEntries: number;
	maxDisplayEntries?: number;
	displayRetentionMs?: number;
	entries: Array<{
		provider: string;
		credentialId: string;
		credentialCacheKey: string;
		fetchedAt: number;
		freshUntil: number;
		staleUntil: number;
		snapshot: UsageSnapshot;
	}>;
	displayEntries?: Array<{
		provider: string;
		credentialId: string;
		credentialCacheKey: string;
		fetchedAt: number;
		displayUntil: number;
		snapshot: UsageSnapshot;
	}>;
}

interface LegacyPersistedUsageCacheTestFile {
	schemaVersion: 1;
	generatedAt: number;
	maxEntries: number;
	entries: Array<{
		provider: string;
		credentialId: string;
		fetchedAt: number;
		freshUntil: number;
		staleUntil: number;
		snapshot: UsageSnapshot;
	}>;
}

function createUsageSnapshot(provider: string, timestamp: number = Date.now()): UsageSnapshot {
	return {
		timestamp,
		provider,
		planType: null,
		primary: null,
		secondary: null,
		credits: null,
		copilotQuota: null,
		updatedAt: timestamp,
	};
}

function createBase64UrlJson(value: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(value), "utf-8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function createCodexIdentityJwt(options: {
	expiresAtSeconds: number;
	accountId: string;
	accountUserId: string;
	email: string;
}): string {
	return [
		createBase64UrlJson({ alg: "none", typ: "JWT" }),
		createBase64UrlJson({
			exp: options.expiresAtSeconds,
			"https://api.openai.com/auth": {
				chatgpt_account_id: options.accountId,
				chatgpt_account_user_id: options.accountUserId,
			},
			"https://api.openai.com/profile": {
				email: options.email,
			},
		}),
		"signature",
	].join(".");
}

function createUsageCacheRecord(
	providerId: string,
	credentialId: string,
	fetchedAt: number,
	credentialCacheKey: string = `cache:${credentialId}`,
): UsageCacheRecord {
	return {
		providerId,
		credentialId,
		credentialCacheKey,
		result: {
			snapshot: createUsageSnapshot(providerId, fetchedAt),
			error: null,
			fetchedAt,
		},
		freshUntil: fetchedAt + 30_000,
		staleUntil: fetchedAt + 300_000,
	};
}

async function createTempUsageCachePath(): Promise<{ tempRoot: string; cachePath: string }> {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-usage-cache-"));
	return { tempRoot, cachePath: join(tempRoot, "multi-auth-usage-cache.json") };
}

async function readPersistedCache(cachePath: string): Promise<PersistedUsageCacheTestFile> {
	return JSON.parse(await readFile(cachePath, "utf-8")) as PersistedUsageCacheTestFile;
}

test("usage service persists successful snapshots with bounded cache metadata", async (t) => {
	const { tempRoot, cachePath } = await createTempUsageCachePath();
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const providerId = "persistent-provider";
	const credentialId = "credential-a";
	const snapshot = createUsageSnapshot(providerId);
	const usageService = new UsageService(30_000, 300_000, 10_000, undefined, {
		persistentCache: new UsageSnapshotCacheStore({ filePath: cachePath, maxEntries: 100 }),
	});
	usageService.register({
		id: providerId,
		displayName: providerId,
		fetchUsage: async (_auth: UsageAuth) => snapshot,
	});

	const result = await usageService.fetchUsage(
		providerId,
		credentialId,
		{ accessToken: "token" },
		{ forceRefresh: true },
	);
	const persisted = await readPersistedCache(cachePath);

	assert.equal(usageService.getPersistentCachePath(), cachePath);
	assert.equal(result.error, null);
	assert.equal(persisted.schemaVersion, USAGE_CACHE_SCHEMA_VERSION);
	assert.equal(persisted.maxEntries, 100);
	assert.equal(persisted.entries.length, 1);
	assert.equal(persisted.entries[0]?.provider, providerId);
	assert.equal(persisted.entries[0]?.credentialId, credentialId);
	assert.equal(persisted.entries[0]?.fetchedAt, result.fetchedAt);
	assert.equal((persisted.entries[0]?.freshUntil ?? 0) > result.fetchedAt, true);
	assert.equal((persisted.entries[0]?.staleUntil ?? 0) >= (persisted.entries[0]?.freshUntil ?? 0), true);
	assert.deepEqual(persisted.entries[0]?.snapshot, snapshot);
});

test("usage service hydrates valid non-expired entries and prunes expired or orphaned entries", async (t) => {
	const { tempRoot, cachePath } = await createTempUsageCachePath();
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const now = Date.now();
	const providerId = "hydrate-provider";
	const validCredentialId = "credential-valid";
	const expiredCredentialId = "credential-expired";
	const orphanCredentialId = "credential-orphan";
	const validSnapshot = createUsageSnapshot(providerId, now);
	const persisted: PersistedUsageCacheTestFile = {
		schemaVersion: USAGE_CACHE_SCHEMA_VERSION,
		generatedAt: now,
		maxEntries: 10,
		entries: [
			{
				provider: providerId,
				credentialId: validCredentialId,
				credentialCacheKey: `cache:${validCredentialId}`,
				fetchedAt: now,
				freshUntil: now + 30_000,
				staleUntil: now + 300_000,
				snapshot: validSnapshot,
			},
			{
				provider: providerId,
				credentialId: expiredCredentialId,
				credentialCacheKey: `cache:${expiredCredentialId}`,
				fetchedAt: now - 600_000,
				freshUntil: now - 500_000,
				staleUntil: now - 1,
				snapshot: createUsageSnapshot(providerId, now - 600_000),
			},
			{
				provider: providerId,
				credentialId: orphanCredentialId,
				credentialCacheKey: `cache:${orphanCredentialId}`,
				fetchedAt: now,
				freshUntil: now + 30_000,
				staleUntil: now + 300_000,
				snapshot: createUsageSnapshot(providerId, now),
			},
		],
	};
	await writeFile(cachePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf-8");

	const usageService = new UsageService(30_000, 300_000, 10_000, undefined, {
		persistentCache: new UsageSnapshotCacheStore({ filePath: cachePath, maxEntries: 10 }),
	});
	await usageService.hydratePersistedCache({
		isCredentialValid: (_provider, credentialId) => credentialId === validCredentialId,
		pruneInvalidEntries: true,
	});

	const hydrated = usageService.readCachedUsage(providerId, validCredentialId);
	assert.deepEqual(hydrated?.snapshot, validSnapshot);
	assert.equal(hydrated?.fromCache, true);
	assert.equal(usageService.readCachedUsage(providerId, expiredCredentialId, { allowStale: true }), null);
	assert.equal(usageService.readCachedUsage(providerId, orphanCredentialId), null);

	const pruned = await readPersistedCache(cachePath);
	assert.deepEqual(
		pruned.entries.map((entry) => entry.credentialId),
		[validCredentialId],
	);
});

test("usage service hydrates display snapshots after operational entries expire", async (t) => {
	const { tempRoot, cachePath } = await createTempUsageCachePath();
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const now = Date.now();
	const providerId = "display-provider";
	const validCredentialId = "credential-valid";
	const orphanCredentialId = "credential-orphan";
	const validCredentialCacheKey = `cache:${validCredentialId}`;
	const validSnapshot = { ...createUsageSnapshot(providerId, now), planType: "pro" };
	const persisted: PersistedUsageCacheTestFile = {
		schemaVersion: USAGE_CACHE_SCHEMA_VERSION,
		generatedAt: now,
		maxEntries: 10,
		maxDisplayEntries: 10,
		displayRetentionMs: 86_400_000,
		entries: [
			{
				provider: providerId,
				credentialId: validCredentialId,
				credentialCacheKey: validCredentialCacheKey,
				fetchedAt: now - 600_000,
				freshUntil: now - 500_000,
				staleUntil: now - 1,
				snapshot: validSnapshot,
			},
		],
		displayEntries: [
			{
				provider: providerId,
				credentialId: validCredentialId,
				credentialCacheKey: validCredentialCacheKey,
				fetchedAt: now - 600_000,
				displayUntil: now + 86_400_000,
				snapshot: validSnapshot,
			},
			{
				provider: providerId,
				credentialId: orphanCredentialId,
				credentialCacheKey: `cache:${orphanCredentialId}`,
				fetchedAt: now - 600_000,
				displayUntil: now + 86_400_000,
				snapshot: createUsageSnapshot(providerId, now - 600_000),
			},
		],
	};
	await writeFile(cachePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf-8");

	const usageService = new UsageService(30_000, 300_000, 10_000, undefined, {
		persistentCache: new UsageSnapshotCacheStore({ filePath: cachePath, maxEntries: 10 }),
	});
	await usageService.hydratePersistedCache({
		isCredentialValid: (_provider, credentialId, credentialCacheKey) =>
			credentialId === validCredentialId && credentialCacheKey === validCredentialCacheKey,
		pruneInvalidEntries: true,
	});

	const operational = usageService.readCachedUsage(providerId, validCredentialId, { allowStale: true });
	const display = usageService.readDisplayUsage(providerId, validCredentialId);
	const pruned = await readPersistedCache(cachePath);

	assert.equal(operational, null);
	assert.equal(display?.fromCache, true);
	assert.equal(display?.snapshot?.planType, "pro");
	assert.deepEqual(pruned.entries, []);
	assert.deepEqual(
		(pruned.displayEntries ?? []).map((entry) => entry.credentialId),
		[validCredentialId],
	);
});

test("usage service migrates safely associated schema-v1 cache entries to credential-keyed schema-v2", async (t) => {
	const { tempRoot, cachePath } = await createTempUsageCachePath();
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const now = Date.now();
	const providerId = "legacy-provider";
	const credentialId = "credential-a";
	const currentCredentialCacheKey = createUsageCredentialCacheKey(providerId, credentialId, {
		accessToken: "legacy-compatible-token",
		accountId: "legacy-compatible-account",
	});
	const legacySnapshot = createUsageSnapshot(providerId, now);
	const legacyCache: LegacyPersistedUsageCacheTestFile = {
		schemaVersion: 1,
		generatedAt: now,
		maxEntries: 10,
		entries: [
			{
				provider: providerId,
				credentialId,
				fetchedAt: now,
				freshUntil: now + 30_000,
				staleUntil: now + 300_000,
				snapshot: legacySnapshot,
			},
		],
	};
	await writeFile(cachePath, `${JSON.stringify(legacyCache, null, 2)}\n`, "utf-8");

	const usageService = new UsageService(30_000, 300_000, 10_000, undefined, {
		persistentCache: new UsageSnapshotCacheStore({ filePath: cachePath, maxEntries: 10 }),
	});
	await usageService.hydratePersistedCache({
		isCredentialValid: (provider, credential, credentialCacheKey) =>
			provider === providerId && credential === credentialId && credentialCacheKey === currentCredentialCacheKey,
		resolveLegacyCredentialCacheKey: (provider, credential) =>
			provider === providerId && credential === credentialId ? currentCredentialCacheKey : null,
		pruneInvalidEntries: true,
	});

	const hydrated = usageService.readCachedUsage(providerId, credentialId);
	const migrated = await readPersistedCache(cachePath);

	assert.deepEqual(hydrated?.snapshot, legacySnapshot);
	assert.equal(hydrated?.fromCache, true);
	assert.equal(migrated.schemaVersion, USAGE_CACHE_SCHEMA_VERSION);
	assert.equal(migrated.entries.length, 1);
	assert.equal(migrated.entries[0]?.credentialCacheKey, currentCredentialCacheKey);
});

test("usage service prunes ambiguous or invalid schema-v1 cache entries during migration", async (t) => {
	const { tempRoot, cachePath } = await createTempUsageCachePath();
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const now = Date.now();
	const providerId = "legacy-prune-provider";
	const validCredentialId = "credential-valid";
	const ambiguousCredentialId = "credential-ambiguous";
	const invalidCredentialId = "credential-invalid";
	const validCredentialCacheKey = createUsageCredentialCacheKey(providerId, validCredentialId, {
		accessToken: "legacy-prune-token",
		accountId: "legacy-prune-account",
	});
	const validSnapshot = createUsageSnapshot(providerId, now);
	const legacyCache: LegacyPersistedUsageCacheTestFile = {
		schemaVersion: 1,
		generatedAt: now,
		maxEntries: 10,
		entries: [
			{
				provider: providerId,
				credentialId: validCredentialId,
				fetchedAt: now,
				freshUntil: now + 30_000,
				staleUntil: now + 300_000,
				snapshot: validSnapshot,
			},
			{
				provider: providerId,
				credentialId: ambiguousCredentialId,
				fetchedAt: now,
				freshUntil: now + 30_000,
				staleUntil: now + 300_000,
				snapshot: createUsageSnapshot(providerId, now),
			},
			{
				provider: providerId,
				credentialId: invalidCredentialId,
				fetchedAt: now,
				freshUntil: now + 30_000,
				staleUntil: now + 300_000,
				snapshot: createUsageSnapshot("different-provider", now),
			},
		],
	};
	await writeFile(cachePath, `${JSON.stringify(legacyCache, null, 2)}\n`, "utf-8");

	const usageService = new UsageService(30_000, 300_000, 10_000, undefined, {
		persistentCache: new UsageSnapshotCacheStore({ filePath: cachePath, maxEntries: 10 }),
	});
	await usageService.hydratePersistedCache({
		isCredentialValid: (_provider, credentialId, credentialCacheKey) =>
			credentialId === validCredentialId && credentialCacheKey === validCredentialCacheKey,
		resolveLegacyCredentialCacheKey: (_provider, credentialId) =>
			credentialId === validCredentialId ? validCredentialCacheKey : null,
		pruneInvalidEntries: true,
	});

	const migrated = await readPersistedCache(cachePath);

	assert.deepEqual(usageService.readCachedUsage(providerId, validCredentialId)?.snapshot, validSnapshot);
	assert.equal(usageService.readCachedUsage(providerId, ambiguousCredentialId), null);
	assert.equal(usageService.readCachedUsage(providerId, invalidCredentialId), null);
	assert.equal(migrated.schemaVersion, USAGE_CACHE_SCHEMA_VERSION);
	assert.deepEqual(
		migrated.entries.map((entry) => entry.credentialId),
		[validCredentialId],
	);
	assert.equal(migrated.entries[0]?.credentialCacheKey, validCredentialCacheKey);
});

test("usage cache store keeps one latest entry per provider credential within the hard entry bound", async (t) => {
	const { tempRoot, cachePath } = await createTempUsageCachePath();
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const store = new UsageSnapshotCacheStore({ filePath: cachePath, maxEntries: 2 });
	await store.persistSuccessfulEntry(createUsageCacheRecord("bounded-provider", "credential-a", 1_000), 1_000);
	await store.persistSuccessfulEntry(createUsageCacheRecord("bounded-provider", "credential-b", 2_000), 1_000);
	await store.persistSuccessfulEntry(createUsageCacheRecord("bounded-provider", "credential-a", 3_000), 1_000);
	await store.persistSuccessfulEntry(createUsageCacheRecord("bounded-provider", "credential-c", 4_000), 1_000);

	const persisted = await readPersistedCache(cachePath);
	assert.equal(persisted.entries.length, 2);
	assert.deepEqual(
		persisted.entries.map((entry) => `${entry.credentialId}:${entry.fetchedAt}`),
		["credential-c:4000", "credential-a:3000"],
	);
	assert.equal(new Set(persisted.entries.map((entry) => entry.credentialId)).size, 2);
});

test("usage service ignores malformed persisted cache files during hydration", async (t) => {
	const { tempRoot, cachePath } = await createTempUsageCachePath();
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	await writeFile(cachePath, "{ not valid json", "utf-8");
	const usageService = new UsageService(30_000, 300_000, 10_000, undefined, {
		persistentCache: new UsageSnapshotCacheStore({ filePath: cachePath }),
	});

	await assert.doesNotReject(() => usageService.hydratePersistedCache());
	assert.equal(usageService.readCachedUsage("missing-provider", "missing-credential"), null);
});

test("usage service does not overwrite last persisted successful snapshot with transient errors", async (t) => {
	const { tempRoot, cachePath } = await createTempUsageCachePath();
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const providerId = "error-preserve-provider";
	const credentialId = "credential-a";
	const firstSnapshot = createUsageSnapshot(providerId);
	let shouldFail = false;
	const usageService = new UsageService(30_000, 300_000, 10_000, undefined, {
		persistentCache: new UsageSnapshotCacheStore({ filePath: cachePath }),
	});
	usageService.register({
		id: providerId,
		displayName: providerId,
		fetchUsage: async (_auth: UsageAuth) => {
			if (shouldFail) {
				throw new Error("transient upstream failure");
			}
			return firstSnapshot;
		},
	});

	await usageService.fetchUsage(providerId, credentialId, { accessToken: "token" }, { forceRefresh: true });
	const persistedAfterSuccess = await readPersistedCache(cachePath);
	shouldFail = true;

	const failedResult = await usageService.fetchUsage(
		providerId,
		credentialId,
		{ accessToken: "token" },
		{ forceRefresh: true },
	);
	const persistedAfterError = await readPersistedCache(cachePath);

	assert.match(failedResult.error ?? "", /transient upstream failure/);
	assert.deepEqual(persistedAfterError.entries, persistedAfterSuccess.entries);
	assert.deepEqual(persistedAfterError.entries[0]?.snapshot, firstSnapshot);
});


test("usage service separates cache records for reused credential ids with different credential material", async (t) => {
	const { tempRoot, cachePath } = await createTempUsageCachePath();
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const providerId = "openai-codex";
	const credentialId = "openai-codex";
	const freeSnapshot = { ...createUsageSnapshot(providerId), planType: "free" };
	const teamSnapshot = { ...createUsageSnapshot(providerId), planType: "ChatGPT Team" };
	const usageService = new UsageService(30_000, 300_000, 10_000, undefined, {
		persistentCache: new UsageSnapshotCacheStore({ filePath: cachePath, maxEntries: 10 }),
	});
	let activeSnapshot = freeSnapshot;
	usageService.register({
		id: providerId,
		displayName: providerId,
		fetchUsage: async () => activeSnapshot,
	});

	await usageService.fetchUsage(
		providerId,
		credentialId,
		{ accessToken: "free-token", accountId: "account-free", credential: { accountId: "account-free" } },
		{ forceRefresh: true },
	);
	activeSnapshot = teamSnapshot;
	await usageService.fetchUsage(
		providerId,
		credentialId,
		{ accessToken: "team-token", accountId: "account-team", credential: { accountId: "account-team" } },
		{ forceRefresh: true },
	);

	const ambiguousRead = usageService.readCachedUsage(providerId, credentialId, { allowStale: true });
	const persisted = await readPersistedCache(cachePath);

	assert.equal(ambiguousRead, null);
	assert.equal(persisted.entries.length, 2);
	assert.equal(new Set(persisted.entries.map((entry) => entry.credentialCacheKey)).size, 2);
	assert.deepEqual(
		persisted.entries.map((entry) => entry.snapshot.planType).sort(),
		["ChatGPT Team", "free"],
	);
});

test("account manager hydrates persisted usage cache during initialization and serves warm-start reads", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-usage-cache-account-manager-"));
	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const cachePath = join(tempRoot, "multi-auth-usage-cache.json");
	const providerId = "warm-start-provider";
	const credentialId = providerId;
	const now = Date.now();
	const hydratedSnapshot = createUsageSnapshot(providerId, now);
	const warmStartKey = "warm-start-key";
	let fetchCount = 0;

	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	await writeFile(
		authPath,
		JSON.stringify(
			{
				[credentialId]: { type: "api_key", key: warmStartKey },
			},
			null,
			2,
		),
		"utf-8",
	);
	await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");
	await writeFile(
		cachePath,
		`${JSON.stringify(
			{
				schemaVersion: USAGE_CACHE_SCHEMA_VERSION,
				generatedAt: now,
				maxEntries: 10,
				entries: [
					{
						provider: providerId,
						credentialId,
						credentialCacheKey: createUsageCredentialCacheKey(providerId, credentialId, {
							accessToken: warmStartKey,
							credential: { type: "api_key", key: warmStartKey },
						}),
						fetchedAt: now,
						freshUntil: now + 30_000,
						staleUntil: now + 300_000,
						snapshot: hydratedSnapshot,
					},
					{
						provider: providerId,
						credentialId: "orphaned-credential",
						credentialCacheKey: "cache:orphaned-credential",
						fetchedAt: now,
						freshUntil: now + 30_000,
						staleUntil: now + 300_000,
						snapshot: createUsageSnapshot(providerId, now),
					},
				],
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);

	const authWriter = new AuthWriter(authPath);
	const storage = new MultiAuthStorage(storagePath);
	const usageService = new UsageService(30_000, 300_000, 10_000, undefined, {
		persistentCache: new UsageSnapshotCacheStore({ filePath: cachePath, maxEntries: 10 }),
	});
	usageService.register({
		id: providerId,
		displayName: providerId,
		fetchUsage: async () => {
			fetchCount += 1;
			return createUsageSnapshot(providerId);
		},
	});
	const providerRegistry = new ProviderRegistry(authWriter, modelsPath, [providerId]);
	const accountManager = new AccountManager(authWriter, storage, usageService, providerRegistry);

	t.after(() => {
		accountManager.shutdown();
	});

	await accountManager.ensureInitialized();
	Object.defineProperty(authWriter, "getCredential", {
		configurable: true,
		value: async () => {
			throw new Error("warm-started usage should not trigger an auth credential read");
		},
	});

	const result = await accountManager.getCredentialUsageSnapshot(providerId, credentialId, {
		maxAgeMs: 30_000,
	});
	const prunedCache = await readPersistedCache(cachePath);

	assert.equal(result.error, null);
	assert.equal(result.fromCache, true);
	assert.deepEqual(result.snapshot, hydratedSnapshot);
	assert.equal(fetchCount, 0);
	assert.deepEqual(
		prunedCache.entries.map((entry) => entry.credentialId),
		[credentialId],
	);
});

test("usage service keeps Codex usage snapshots separated for base and numbered credential ids", async (t) => {
	const { tempRoot, cachePath } = await createTempUsageCachePath();
	const providerId = "openai-codex";
	const baseCredentialId = "openai-codex";
	const numberedCredentialId = "openai-codex-17";
	const now = Date.now();
	const expiresAtSeconds = Math.floor(now / 1_000) + 3_600;
	const baseCredential = {
		type: "oauth" as const,
		["access"]: createCodexIdentityJwt({
			expiresAtSeconds,
			accountId: "acct-personal",
			accountUserId: "user-same",
			email: "same@example.com",
		}),
		refresh: "refresh-base",
		expires: now + 180_000,
		provider: providerId,
		accountId: "acct-personal",
	};
	const numberedCredential = {
		type: "oauth" as const,
		["access"]: createCodexIdentityJwt({
			expiresAtSeconds,
			accountId: "acct-team",
			accountUserId: "user-same",
			email: "same@example.com",
		}),
		refresh: "refresh-numbered",
		expires: now + 120_000,
		provider: providerId,
		accountId: "acct-team",
	};
	const baseSnapshot = { ...createUsageSnapshot(providerId, now), planType: "free" };
	const numberedSnapshot = {
		...createUsageSnapshot(providerId, now + 1),
		planType: "ChatGPT Team",
	};
	let nextSnapshot = baseSnapshot;

	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const usageService = new UsageService(30_000, 300_000, 10_000, undefined, {
		persistentCache: new UsageSnapshotCacheStore({ filePath: cachePath, maxEntries: 10 }),
	});
	usageService.register({
		id: providerId,
		displayName: providerId,
		fetchUsage: async () => nextSnapshot,
	});

	nextSnapshot = baseSnapshot;
	await usageService.fetchUsage(
		providerId,
		baseCredentialId,
		{ accessToken: baseCredential.access, accountId: "acct-personal", credential: baseCredential },
		{ forceRefresh: true },
	);
	nextSnapshot = numberedSnapshot;
	await usageService.fetchUsage(
		providerId,
		numberedCredentialId,
		{ accessToken: numberedCredential.access, accountId: "acct-team", credential: numberedCredential },
		{ forceRefresh: true },
	);

	const baseUsage = usageService.readCachedUsage(providerId, baseCredentialId, { maxAgeMs: 30_000 });
	const numberedUsage = usageService.readCachedUsage(providerId, numberedCredentialId, {
		maxAgeMs: 30_000,
	});
	usageService.clearCredential(providerId, baseCredentialId);
	const baseUsageAfterClear = usageService.readCachedUsage(providerId, baseCredentialId, {
		allowStale: true,
	});
	const numberedUsageAfterClear = usageService.readCachedUsage(providerId, numberedCredentialId, {
		allowStale: true,
	});
	const persisted = await readPersistedCache(cachePath);

	assert.equal(baseUsage?.error, null);
	assert.equal(baseUsage?.fromCache, true);
	assert.equal(baseUsage?.snapshot?.planType, "free");
	assert.equal(numberedUsage?.error, null);
	assert.equal(numberedUsage?.fromCache, true);
	assert.equal(numberedUsage?.snapshot?.planType, "ChatGPT Team");
	assert.equal(baseUsageAfterClear, null);
	assert.equal(numberedUsageAfterClear?.snapshot?.planType, "ChatGPT Team");
	assert.deepEqual(
		persisted.entries.map((entry) => entry.credentialId).sort(),
		[baseCredentialId, numberedCredentialId].sort(),
	);
});
