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
	isPlanEligibleForModel,
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
};

function createUsageSnapshot(planType: string | null): UsageSnapshot {
	const now = Date.now();
	return {
		timestamp: now,
		provider: CODEX_PROVIDER_ID,
		planType,
		primary: null,
		secondary: null,
		credits: null,
		copilotQuota: null,
		updatedAt: now,
	};
}

async function createCodexAccountManager(
	t: TestContext,
	credentials: readonly TestCredential[],
): Promise<AccountManager> {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-entitlement-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const planTypeBySecret = new Map<string, string | null>(
		credentials.map((credential) => [credential.secret, credential.planType]),
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
	const usageService = new UsageService();
	usageService.register({
		id: CODEX_PROVIDER_ID,
		displayName: "OpenAI Codex",
		fetchUsage: async (auth: UsageAuth) =>
			createUsageSnapshot(planTypeBySecret.get(auth.accessToken) ?? null),
	});
	const providerRegistry = new ProviderRegistry(authWriter, modelsPath, [CODEX_PROVIDER_ID]);

	return new AccountManager(authWriter, storage, usageService, providerRegistry);
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

test("account manager skips free codex credentials for restricted models", async (t) => {
	const accountManager = await createCodexAccountManager(t, [
		{ credentialId: "openai-codex", secret: "sk-free-key", planType: "free" },
		{ credentialId: "openai-codex-1", secret: "sk-plus-key", planType: "plus" },
		{ credentialId: "openai-codex-2", secret: "sk-pro-key", planType: "pro" },
	]);

	const selected = await accountManager.acquireCredential(CODEX_PROVIDER_ID, {
		modelId: "gpt-5.4",
	});
	assert.equal(selected.credentialId, "openai-codex-1");
});

test("account manager reuses constrained codex usage lookups across repeated selections", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-entitlement-cache-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

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
	const usageService = new UsageService();
	usageService.register({
		id: CODEX_PROVIDER_ID,
		displayName: "OpenAI Codex",
		fetchUsage: async (auth: UsageAuth) => {
			fetchCountBySecret.set(auth.accessToken, (fetchCountBySecret.get(auth.accessToken) ?? 0) + 1);
			return createUsageSnapshot(planTypeBySecret.get(auth.accessToken) ?? null);
		},
	});
	const providerRegistry = new ProviderRegistry(authWriter, modelsPath, [CODEX_PROVIDER_ID]);
	const accountManager = new AccountManager(authWriter, storage, usageService, providerRegistry);
	const selectionCache = createCredentialSelectionCache();

	t.after(() => {
		accountManager.shutdown();
	});

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
	assert.deepEqual(Object.fromEntries(fetchCountBySecret), {
		"sk-free-key": 1,
		"sk-plus-key": 1,
		"sk-pro-key": 1,
	});
});

test("account manager rejects restricted codex selection when no eligible plan exists", async (t) => {
	const accountManager = await createCodexAccountManager(t, [
		{ credentialId: "openai-codex", secret: "sk-free-key", planType: "free" },
		{ credentialId: "openai-codex-1", secret: "sk-free-key-2", planType: "free" },
	]);

	await assert.rejects(
		() =>
			accountManager.acquireCredential(CODEX_PROVIDER_ID, {
				modelId: "gpt-5.4",
			}),
		/no eligible credentials available with a paid plan|No credentials available with a paid plan/i,
	);
});
