import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	AccountManager,
	createCredentialSelectionCache,
} from "../src/account-manager.js";
import { AuthWriter } from "../src/auth-writer.js";
import {
	DEFAULT_MULTI_AUTH_CONFIG,
	type MultiAuthExtensionConfig,
} from "../src/config.js";
import {
	isPlanEligibleForModel,
	modelPrefersFreePlan,
	modelRequiresEntitlement,
	normalizeCodexPlanType,
} from "../src/model-entitlements.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { MultiAuthStorage } from "../src/storage.js";
import { UsageService } from "../src/usage/index.js";
import type { UsageAuth, UsageSnapshot } from "../src/usage/types.js";

const CODEX_PROVIDER_ID = "openai-codex";

type TestCredential = {
	credentialId: string;
	secret: string;
	planType: string | null;
	primaryUsedPercent?: number;
	usageError?: string;
};

type CodexAccountManagerTestOptions = {
	extensionConfig?: MultiAuthExtensionConfig;
	onFetchUsage?: (credential: TestCredential | undefined) => void | Promise<void>;
};

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolveDeferred: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolveDeferred = resolve;
	});
	if (!resolveDeferred) {
		throw new Error("Failed to initialize deferred test gate.");
	}
	return { promise, resolve: resolveDeferred };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function createUsageSnapshot(credential: Pick<TestCredential, "planType" | "primaryUsedPercent">): UsageSnapshot {
	const now = Date.now();
	const primaryUsedPercent = credential.primaryUsedPercent;
	return {
		timestamp: now,
		provider: CODEX_PROVIDER_ID,
		planType: credential.planType,
		primary: typeof primaryUsedPercent === "number"
			? { usedPercent: primaryUsedPercent, windowMinutes: 10_080, resetsAt: Math.ceil((now + 10_080 * 60_000) / 1000) }
			: null,
		secondary: null,
		credits: null,
		copilotQuota: null,
		updatedAt: now,
	};
}

async function createCodexAccountManager(
	t: TestContext,
	credentials: readonly TestCredential[],
	options: CodexAccountManagerTestOptions = {},
): Promise<AccountManager> {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-entitlement-"));

	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const credentialBySecret = new Map(
		credentials.map((credential) => [credential.secret, credential]),
	);

	await writeFile(
		authPath,
		JSON.stringify(
			Object.fromEntries(
				credentials.map((credential) => [
					credential.credentialId,
					{ type: "api_key", key: credential.secret },
				]),
			),
			null,
			2,
		),
		"utf-8",
	);
	await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");

	const authWriter = new AuthWriter(authPath);
	const storage = new MultiAuthStorage(storagePath);
	const usageService = new UsageService(undefined, undefined, undefined, undefined, { persistentCache: false });
	usageService.register({
		id: CODEX_PROVIDER_ID,
		displayName: "OpenAI Codex",
		fetchUsage: async (auth: UsageAuth) => {
			const credential = credentialBySecret.get(auth.accessToken);
			await options.onFetchUsage?.(credential);
			if (credential?.usageError) {
				throw new Error(credential.usageError);
			}
			return createUsageSnapshot(credential ?? { planType: null });
		},
	});
	const providerRegistry = new ProviderRegistry(authWriter, modelsPath, [CODEX_PROVIDER_ID]);
	const accountManager = new AccountManager(authWriter, storage, usageService, providerRegistry, undefined, options.extensionConfig);
	t.after(async () => {
		await accountManager.shutdown();
		await rm(tempRoot, { recursive: true, force: true });
	});

	return accountManager;
}

async function preloadCodexUsage(
	accountManager: AccountManager,
	credentialIds: readonly string[],
): Promise<void> {
	for (const credentialId of credentialIds) {
		await accountManager.getCredentialUsageSnapshot(CODEX_PROVIDER_ID, credentialId, {
			forceRefresh: true,
		});
	}
}

test("codex plan normalization recognizes paid-plan labels for restricted models", () => {
	assert.equal(normalizeCodexPlanType("free"), "free");
	assert.equal(normalizeCodexPlanType("ChatGPT Plus"), "plus");
	assert.equal(normalizeCodexPlanType("ChatGPT Pro"), "pro");
	assert.equal(normalizeCodexPlanType("chatgpt_team"), "team");
	assert.equal(normalizeCodexPlanType(null), "unknown");
	assert.equal(isPlanEligibleForModel("plus"), true);
	assert.equal(isPlanEligibleForModel("enterprise"), true);
	assert.equal(isPlanEligibleForModel("free"), false);
	assert.equal(isPlanEligibleForModel("unknown"), false);
	assert.equal(modelPrefersFreePlan(CODEX_PROVIDER_ID, "gpt-5.4"), true);
	assert.equal(modelRequiresEntitlement(CODEX_PROVIDER_ID, "gpt-5.4"), false);
	assert.equal(modelRequiresEntitlement(CODEX_PROVIDER_ID, "gpt-5.5"), true);
});

test("account manager preserves current selection for unconstrained codex requests", async (t) => {
	const accountManager = await createCodexAccountManager(t, [
		{ credentialId: "openai-codex", secret: "sk-free-key", planType: "free" },
		{ credentialId: "openai-codex-1", secret: "sk-plus-key", planType: "plus" },
	]);

	const selected = await accountManager.acquireCredential(CODEX_PROVIDER_ID);
	assert.equal(selected.credentialId, "openai-codex");
	assert.equal(selected.provider, CODEX_PROVIDER_ID);
});

test("account manager prefers free codex credentials for free-eligible models", async (t) => {
	const accountManager = await createCodexAccountManager(t, [
		{ credentialId: "openai-codex", secret: "sk-free-key", planType: "free" },
		{ credentialId: "openai-codex-1", secret: "sk-plus-key", planType: "plus" },
		{ credentialId: "openai-codex-2", secret: "sk-pro-key", planType: "pro" },
	]);

	const selected = await accountManager.acquireCredential(CODEX_PROVIDER_ID, {
		modelId: "gpt-5.4",
	});
	assert.equal(selected.credentialId, "openai-codex");
});

test("account manager reuses codex model routing usage lookups across repeated selections", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-entitlement-cache-"));

	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const credentials = [
		{ credentialId: "openai-codex", secret: "sk-free-key", planType: "free" },
		{ credentialId: "openai-codex-1", secret: "sk-plus-key", planType: "plus" },
		{ credentialId: "openai-codex-2", secret: "sk-pro-key", planType: "pro" },
	] as const;
	const planTypeBySecret = new Map<string, string | null>(
		credentials.map((credential) => [credential.secret, credential.planType]),
	);
	const fetchCountBySecret = new Map<string, number>();

	await writeFile(
		authPath,
		JSON.stringify(
			Object.fromEntries(
				credentials.map((credential) => [
					credential.credentialId,
					{ type: "api_key", key: credential.secret },
				]),
			),
			null,
			2,
		),
		"utf-8",
	);
	await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");

	const authWriter = new AuthWriter(authPath);
	const storage = new MultiAuthStorage(storagePath);
	const usageService = new UsageService(undefined, undefined, undefined, undefined, { persistentCache: false });
	usageService.register({
		id: CODEX_PROVIDER_ID,
		displayName: "OpenAI Codex",
		fetchUsage: async (auth: UsageAuth) => {
			fetchCountBySecret.set(auth.accessToken, (fetchCountBySecret.get(auth.accessToken) ?? 0) + 1);
			return createUsageSnapshot({ planType: planTypeBySecret.get(auth.accessToken) ?? null });
		},
	});
	const providerRegistry = new ProviderRegistry(authWriter, modelsPath, [CODEX_PROVIDER_ID]);
	const accountManager = new AccountManager(authWriter, storage, usageService, providerRegistry);
	const selectionCache = createCredentialSelectionCache();

	t.after(async () => {
		await accountManager.shutdown();
		await rm(tempRoot, { recursive: true, force: true });
	});

	await preloadCodexUsage(accountManager, credentials.map((credential) => credential.credentialId));
	fetchCountBySecret.clear();

	const first = await accountManager.acquireCredential(CODEX_PROVIDER_ID, {
		modelId: "gpt-5.4",
		excludedCredentialIds: new Set(["openai-codex"]),
		selectionCache,
	});
	const second = await accountManager.acquireCredential(CODEX_PROVIDER_ID, {
		modelId: "gpt-5.4",
		excludedCredentialIds: new Set(["openai-codex", "openai-codex-1"]),
		selectionCache,
	});

	assert.equal(first.credentialId, "openai-codex-1");
	assert.equal(second.credentialId, "openai-codex-2");
	assert.deepEqual(Object.fromEntries(fetchCountBySecret), {});
});

test("account manager falls back to paid codex credentials when free usage is exhausted", async (t) => {
	const credentials = [
		{ credentialId: "openai-codex", secret: "sk-free-key", planType: "free", primaryUsedPercent: 100 },
		{ credentialId: "openai-codex-1", secret: "sk-plus-key", planType: "plus", primaryUsedPercent: 10 },
	] as const;
	const accountManager = await createCodexAccountManager(t, credentials);
	await preloadCodexUsage(accountManager, credentials.map((credential) => credential.credentialId));

	const selected = await accountManager.acquireCredential(CODEX_PROVIDER_ID, {
		modelId: "gpt-5.4",
	});
	assert.equal(selected.credentialId, "openai-codex-1");
});

test("account manager skips free codex credentials for paid-only models", async (t) => {
	const accountManager = await createCodexAccountManager(t, [
		{ credentialId: "openai-codex", secret: "sk-free-key", planType: "free" },
		{ credentialId: "openai-codex-1", secret: "sk-plus-key", planType: "plus" },
	]);

	const selected = await accountManager.acquireCredential(CODEX_PROVIDER_ID, {
		modelId: "gpt-5.5",
	});
	assert.equal(selected.credentialId, "openai-codex-1");
});

test("account manager skips codex credentials with cached model incompatibility", async (t) => {
	const accountManager = await createCodexAccountManager(t, [
		{ credentialId: "openai-codex", secret: "sk-free-key", planType: "free" },
		{ credentialId: "openai-codex-1", secret: "sk-plus-key", planType: "plus" },
	]);
	await preloadCodexUsage(accountManager, ["openai-codex", "openai-codex-1"]);

	await (accountManager as unknown as {
		markCredentialModelIncompatible: (
			provider: string,
			credentialId: string,
			modelId: string,
			errorMessage: string,
		) => Promise<number>;
	}).markCredentialModelIncompatible(
		CODEX_PROVIDER_ID,
		"openai-codex",
		"gpt-5.4",
		"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
	);

	const selected = await accountManager.acquireCredential(CODEX_PROVIDER_ID, {
		modelId: "gpt-5.4",
	});
	assert.equal(selected.credentialId, "openai-codex-1");
});

test("account manager scans later usage windows when earlier codex credentials are exhausted", async (t) => {
	const credentials = [
		{ credentialId: "openai-codex", secret: "window-free-0", planType: "free", primaryUsedPercent: 100 },
		{ credentialId: "openai-codex-1", secret: "window-free-1", planType: "free", primaryUsedPercent: 100 },
		{ credentialId: "openai-codex-2", secret: "window-free-2", planType: "free", primaryUsedPercent: 100 },
		{ credentialId: "openai-codex-3", secret: "window-free-3", planType: "free", primaryUsedPercent: 100 },
		{ credentialId: "openai-codex-4", secret: "window-free-4", planType: "free", primaryUsedPercent: 100 },
		{ credentialId: "openai-codex-5", secret: "window-free-5", planType: "free", primaryUsedPercent: 100 },
		{ credentialId: "openai-codex-6", secret: "window-free-6", planType: "free", primaryUsedPercent: 100 },
		{ credentialId: "openai-codex-7", secret: "window-free-7", planType: "free", primaryUsedPercent: 100 },
		{ credentialId: "openai-codex-8", secret: "window-free-8", planType: "free", primaryUsedPercent: 5 },
	];
	const accountManager = await createCodexAccountManager(t, credentials);
	await preloadCodexUsage(accountManager, credentials.map((credential) => credential.credentialId));

	const selected = await accountManager.acquireCredential(CODEX_PROVIDER_ID);
	assert.equal(selected.credentialId, "openai-codex-8");
});

test("account manager scans later entitlement windows for paid codex credentials", async (t) => {
	const credentials = [
		{ credentialId: "openai-codex", secret: "entitlement-free-0", planType: "free" },
		{ credentialId: "openai-codex-1", secret: "entitlement-free-1", planType: "free" },
		{ credentialId: "openai-codex-2", secret: "entitlement-free-2", planType: "free" },
		{ credentialId: "openai-codex-3", secret: "entitlement-free-3", planType: "free" },
		{ credentialId: "openai-codex-4", secret: "entitlement-free-4", planType: "free" },
		{ credentialId: "openai-codex-5", secret: "entitlement-free-5", planType: "free" },
		{ credentialId: "openai-codex-6", secret: "entitlement-free-6", planType: "free" },
		{ credentialId: "openai-codex-7", secret: "entitlement-free-7", planType: "free" },
		{ credentialId: "openai-codex-8", secret: "entitlement-free-8", planType: "free" },
		{ credentialId: "openai-codex-9", secret: "entitlement-free-9", planType: "free" },
		{ credentialId: "openai-codex-10", secret: "entitlement-free-10", planType: "free" },
		{ credentialId: "openai-codex-11", secret: "entitlement-team-11", planType: "ChatGPT Team" },
	];
	const accountManager = await createCodexAccountManager(t, credentials);
	await preloadCodexUsage(accountManager, credentials.map((credential) => credential.credentialId));

	const selected = await accountManager.acquireCredential(CODEX_PROVIDER_ID, {
		modelId: "gpt-5.5",
	});
	assert.equal(selected.credentialId, "openai-codex-11");
});

test("codex zero-evidence paid entitlement bootstrap scans later bounded windows", async (t) => {
	const credentials = Array.from({ length: 5 }, (_unused, index): TestCredential => ({
		credentialId: index === 0 ? CODEX_PROVIDER_ID : `${CODEX_PROVIDER_ID}-${index}`,
		secret: `codex-bootstrap-token-${index}`,
		planType: index === 4 ? "ChatGPT Plus" : "free",
	}));
	const extensionConfig: MultiAuthExtensionConfig = {
		...DEFAULT_MULTI_AUTH_CONFIG,
		usageCoordination: {
			...DEFAULT_MULTI_AUTH_CONFIG.usageCoordination,
			globalMaxConcurrentFreshRequests: 3,
			perProviderMaxConcurrentFreshRequests: 3,
			entitlementCandidateWindow: 3,
		},
	};
	const fetchedCredentialIds: string[] = [];
	const earlyLaterWindowCredentialIds: string[] = [];
	const firstWindowGate = createDeferred();
	let firstWindowStartCount = 0;
	let firstWindowReleased = false;
	const accountManager = await createCodexAccountManager(t, credentials, {
		extensionConfig,
		onFetchUsage: async (credential) => {
			if (!credential) {
				throw new Error("Expected usage lookup to resolve a known test credential.");
			}
			const credentialIndex = credentials.findIndex(
				(candidate) => candidate.credentialId === credential.credentialId,
			);
			fetchedCredentialIds.push(credential.credentialId);
			if (credentialIndex >= extensionConfig.usageCoordination.entitlementCandidateWindow && !firstWindowReleased) {
				earlyLaterWindowCredentialIds.push(credential.credentialId);
			}
			if (credentialIndex < extensionConfig.usageCoordination.entitlementCandidateWindow) {
				firstWindowStartCount += 1;
				if (firstWindowStartCount === extensionConfig.usageCoordination.entitlementCandidateWindow) {
					firstWindowReleased = true;
					firstWindowGate.resolve();
				}
				await firstWindowGate.promise;
			}
		},
	});

	const selected = await accountManager.acquireCredential(CODEX_PROVIDER_ID, {
		modelId: "gpt-5.5",
	});
	assert.equal(selected.credentialId, "openai-codex-4");
	assert.deepEqual(
		fetchedCredentialIds,
		credentials.map((credential) => credential.credentialId),
	);
	assert.deepEqual(earlyLaterWindowCredentialIds, []);

	fetchedCredentialIds.length = 0;
	const cacheFirstSelected = await accountManager.acquireCredential(CODEX_PROVIDER_ID, {
		modelId: "gpt-5.5",
	});
	assert.equal(cacheFirstSelected.credentialId, "openai-codex-4");
	assert.deepEqual(fetchedCredentialIds, []);
});

test("account manager rejects restricted codex selection when no eligible plan exists", async (t) => {
	const accountManager = await createCodexAccountManager(t, [
		{ credentialId: "openai-codex", secret: "sk-free-key", planType: "free" },
		{ credentialId: "openai-codex-1", secret: "sk-free-key-2", planType: "free" },
	]);

	await assert.rejects(
		() =>
			accountManager.acquireCredential(CODEX_PROVIDER_ID, {
				modelId: "gpt-5.5",
			}),
		/no eligible credentials available with a paid plan|No credentials available with a paid plan/i,
	);
});

test("codex usage-based selection returns immediately and queues background refresh for stale routing state", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-cache-first-selection-"));

	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const credentials = [
		{ credentialId: "openai-codex", secret: "sk-free-key", planType: "free", primaryUsedPercent: 100 },
		{ credentialId: "openai-codex-1", secret: "sk-plus-key", planType: "plus", primaryUsedPercent: 1 },
	] as const;
	const planTypeBySecret = new Map<string, Pick<TestCredential, "planType" | "primaryUsedPercent">>(
		credentials.map((credential) => [credential.secret, credential]),
	);
	let fetchCount = 0;
	let blockRefresh = false;
	const refreshGate = createDeferred();

	await writeFile(
		authPath,
		JSON.stringify(
			Object.fromEntries(
				credentials.map((credential) => [
					credential.credentialId,
					{ type: "api_key", key: credential.secret },
				]),
			),
			null,
			2,
		),
		"utf-8",
	);
	await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");

	const authWriter = new AuthWriter(authPath);
	const storage = new MultiAuthStorage(storagePath);
	const usageService = new UsageService(1, 60_000, 10_000, undefined, { persistentCache: false });
	usageService.register({
		id: CODEX_PROVIDER_ID,
		displayName: "OpenAI Codex",
		fetchUsage: async (auth: UsageAuth) => {
			fetchCount += 1;
			if (blockRefresh) {
				await refreshGate.promise;
			}
			return createUsageSnapshot(planTypeBySecret.get(auth.accessToken) ?? { planType: null });
		},
	});
	const providerRegistry = new ProviderRegistry(authWriter, modelsPath, [CODEX_PROVIDER_ID]);
	const accountManager = new AccountManager(authWriter, storage, usageService, providerRegistry);
	t.after(async () => {
		refreshGate.resolve();
		await accountManager.shutdown();
		await rm(tempRoot, { recursive: true, force: true });
	});

	await preloadCodexUsage(accountManager, credentials.map((credential) => credential.credentialId));
	await sleep(5);
	fetchCount = 0;
	blockRefresh = true;

	const selected = await Promise.race([
		accountManager.acquireCredential(CODEX_PROVIDER_ID),
		sleep(200).then(() => {
			throw new Error("cache-first selection waited for a fresh usage refresh");
		}),
	]);

	assert.equal(selected.credentialId, "openai-codex-1");
	await sleep(50);
	assert.equal(fetchCount > 0, true);
	refreshGate.resolve();
});


test("codex stale usage selection keeps local rotation fair while queueing background refresh", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-cache-first-fairness-"));

	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const credentials = [
		{ credentialId: "openai-codex", secret: "low-stale-usage-token", planType: "plus", primaryUsedPercent: 1 },
		{ credentialId: "openai-codex-1", secret: "higher-stale-usage-token", planType: "plus", primaryUsedPercent: 50 },
	] as const;
	const usageBySecret = new Map<string, Pick<TestCredential, "planType" | "primaryUsedPercent">>(
		credentials.map((credential) => [credential.secret, credential]),
	);
	let fetchCount = 0;

	await writeFile(
		authPath,
		JSON.stringify(
			Object.fromEntries(
				credentials.map((credential) => [
					credential.credentialId,
					{ type: "api_key", key: credential.secret },
				]),
			),
			null,
			2,
		),
		"utf-8",
	);
	await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");

	const authWriter = new AuthWriter(authPath);
	const storage = new MultiAuthStorage(storagePath);
	const usageService = new UsageService(1, 60_000, 10_000, undefined, { persistentCache: false });
	usageService.register({
		id: CODEX_PROVIDER_ID,
		displayName: "OpenAI Codex",
		fetchUsage: async (auth: UsageAuth) => {
			fetchCount += 1;
			return createUsageSnapshot(usageBySecret.get(auth.accessToken) ?? { planType: null });
		},
	});
	const providerRegistry = new ProviderRegistry(authWriter, modelsPath, [CODEX_PROVIDER_ID]);
	const accountManager = new AccountManager(authWriter, storage, usageService, providerRegistry);
	t.after(async () => {
		await accountManager.shutdown();
		await rm(tempRoot, { recursive: true, force: true });
	});

	await preloadCodexUsage(accountManager, credentials.map((credential) => credential.credentialId));
	await sleep(5);
	fetchCount = 0;

	const first = await accountManager.acquireCredential(CODEX_PROVIDER_ID, { modelId: "gpt-5.5" });
	const second = await accountManager.acquireCredential(CODEX_PROVIDER_ID, { modelId: "gpt-5.5" });

	assert.equal(first.credentialId, "openai-codex");
	assert.equal(second.credentialId, "openai-codex-1");
	assert.equal(fetchCount > 0, true);
});

test("codex paid entitlement treats stale quota exhaustion as plan evidence while refreshing in background", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-cache-first-plan-only-"));

	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const credentials = [
		{ credentialId: "openai-codex", secret: "paid-stale-exhausted-token", planType: "plus", primaryUsedPercent: 100 },
		{ credentialId: "openai-codex-1", secret: "free-stale-token", planType: "free", primaryUsedPercent: 0 },
	] as const;
	const usageBySecret = new Map<string, Pick<TestCredential, "planType" | "primaryUsedPercent">>(
		credentials.map((credential) => [credential.secret, credential]),
	);
	let fetchCount = 0;

	await writeFile(
		authPath,
		JSON.stringify(
			Object.fromEntries(
				credentials.map((credential) => [
					credential.credentialId,
					{ type: "api_key", key: credential.secret },
				]),
			),
			null,
			2,
		),
		"utf-8",
	);
	await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");

	const authWriter = new AuthWriter(authPath);
	const storage = new MultiAuthStorage(storagePath);
	const usageService = new UsageService(1, 60_000, 10_000, undefined, { persistentCache: false });
	usageService.register({
		id: CODEX_PROVIDER_ID,
		displayName: "OpenAI Codex",
		fetchUsage: async (auth: UsageAuth) => {
			fetchCount += 1;
			return createUsageSnapshot(usageBySecret.get(auth.accessToken) ?? { planType: null });
		},
	});
	const providerRegistry = new ProviderRegistry(authWriter, modelsPath, [CODEX_PROVIDER_ID]);
	const accountManager = new AccountManager(authWriter, storage, usageService, providerRegistry);
	t.after(async () => {
		await accountManager.shutdown();
		await rm(tempRoot, { recursive: true, force: true });
	});

	await preloadCodexUsage(accountManager, credentials.map((credential) => credential.credentialId));
	await sleep(5);
	fetchCount = 0;

	const selected = await accountManager.acquireCredential(CODEX_PROVIDER_ID, { modelId: "gpt-5.5" });

	assert.equal(selected.credentialId, "openai-codex");
	assert.equal(fetchCount > 0, true);
});

test("codex paid entitlement uses durable negative evidence without a fresh bootstrap", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-cache-first-negative-"));

	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const credentials = [
		{ credentialId: "openai-codex", secret: "sk-free-key", planType: "free" },
		{ credentialId: "openai-codex-1", secret: "sk-free-key-2", planType: "free" },
	] as const;
	const planTypeBySecret = new Map<string, string | null>(
		credentials.map((credential) => [credential.secret, credential.planType]),
	);
	let fetchCount = 0;

	await writeFile(
		authPath,
		JSON.stringify(
			Object.fromEntries(
				credentials.map((credential) => [
					credential.credentialId,
					{ type: "api_key", key: credential.secret },
				]),
			),
			null,
			2,
		),
		"utf-8",
	);
	await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");

	const authWriter = new AuthWriter(authPath);
	const storage = new MultiAuthStorage(storagePath);
	const usageService = new UsageService(undefined, undefined, undefined, undefined, { persistentCache: false });
	usageService.register({
		id: CODEX_PROVIDER_ID,
		displayName: "OpenAI Codex",
		fetchUsage: async (auth: UsageAuth) => {
			fetchCount += 1;
			return createUsageSnapshot({ planType: planTypeBySecret.get(auth.accessToken) ?? null });
		},
	});
	const providerRegistry = new ProviderRegistry(authWriter, modelsPath, [CODEX_PROVIDER_ID]);
	const accountManager = new AccountManager(authWriter, storage, usageService, providerRegistry);
	t.after(async () => {
		await accountManager.shutdown();
		await rm(tempRoot, { recursive: true, force: true });
	});

	await preloadCodexUsage(accountManager, credentials.map((credential) => credential.credentialId));
	fetchCount = 0;

	await assert.rejects(
		() => accountManager.acquireCredential(CODEX_PROVIDER_ID, { modelId: "gpt-5.5" }),
		/No credentials available with a paid plan/i,
	);
	assert.equal(fetchCount, 0);
});
