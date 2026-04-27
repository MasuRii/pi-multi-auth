import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AccountManager } from "../src/account-manager.js";
import { AuthWriter } from "../src/auth-writer.js";
import { DEFAULT_MULTI_AUTH_CONFIG, loadMultiAuthConfig } from "../src/config.js";
import { MultiAuthDebugLogger } from "../src/debug-logger.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import {
	PI_AGENT_ROUTER_DELEGATED_API_KEY_ENV,
	PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID_ENV,
	PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID_ENV,
	PI_AGENT_ROUTER_SUBAGENT_ENV,
	resolveDelegatedCredentialOverride,
} from "../src/runtime-context.js";
import { MultiAuthStorage } from "../src/storage.js";
import { UsageService } from "../src/usage/index.js";

const distRoot = fileURLToPath(new URL("..", import.meta.url));

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

const childScript = String.raw`
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const distRoot = process.env.PI_MULTI_AUTH_DIST_ROOT;
if (!distRoot) {
	throw new Error("Missing PI_MULTI_AUTH_DIST_ROOT");
}

const tmpHome = mkdtempSync(join(tmpdir(), "pi-multi-auth-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.PI_CODING_AGENT_DIR = "";
delete process.env.PI_AGENT_ROUTER_SUBAGENT;

const { AccountManager } = await import(
	pathToFileURL(join(distRoot, "src/account-manager.js")).href
);
const { ProviderRegistry } = await import(
	pathToFileURL(join(distRoot, "src/provider-registry.js")).href
);
const { default: extension } = await import(
	pathToFileURL(join(distRoot, "index.js")).href
);

let ensureCalls = 0;
const autoActivateCallOptions = [];
let resolveEnsureStarted;
let releaseEnsure;
const ensureStarted = new Promise((resolve) => {
	resolveEnsureStarted = resolve;
});

const originalEnsureInitialized = AccountManager.prototype.ensureInitialized;
const originalAutoActivatePreferredCredentials =
	AccountManager.prototype.autoActivatePreferredCredentials;
const originalDiscoverProviderIds = ProviderRegistry.prototype.discoverProviderIds;

ProviderRegistry.prototype.discoverProviderIds = async function discoverProviderIdsStub() {
	return [];
};
AccountManager.prototype.ensureInitialized = async function ensureInitializedStub() {
	ensureCalls += 1;
	resolveEnsureStarted?.();
	await new Promise((resolve) => {
		releaseEnsure = resolve;
	});
};
AccountManager.prototype.autoActivatePreferredCredentials =
	async function autoActivatePreferredCredentialsStub(options) {
		autoActivateCallOptions.push(options ?? null);
	};

try {
	const events = new Map();
	const pi = {
		on(event, handler) {
			const handlers = events.get(event) ?? [];
			handlers.push(handler);
			events.set(event, handlers);
		},
		registerCommand() {},
		registerProvider() {},
	};

	await extension(pi);
	const ensureCallsAfterLoad = ensureCalls;

	await new Promise((resolve) => setTimeout(resolve, 0));
	const ensureCallsBeforeSessionStart = ensureCalls;

	const sessionStartHandlers = events.get("session_start") ?? [];
	for (const handler of sessionStartHandlers) {
		handler({}, {
			ui: {
				notify() {},
			},
		});
	}

	await Promise.race([
		ensureStarted,
		new Promise((_, reject) => setTimeout(() => reject(new Error("Warmup did not start after session_start")), 1_000)),
	]);

	const ensureCallsAfterSessionStart = ensureCalls;
	const autoActivateCallsBeforeRelease = autoActivateCallOptions.length;

	releaseEnsure?.();
	await new Promise((resolve) => setTimeout(resolve, 0));

	console.log(
		JSON.stringify({
			ensureCallsAfterLoad,
			ensureCallsBeforeSessionStart,
			ensureCallsAfterSessionStart,
			autoActivateCallsBeforeRelease,
			autoActivateCallOptions,
		}),
	);
} finally {
	AccountManager.prototype.ensureInitialized = originalEnsureInitialized;
	AccountManager.prototype.autoActivatePreferredCredentials =
		originalAutoActivatePreferredCredentials;
	ProviderRegistry.prototype.discoverProviderIds = originalDiscoverProviderIds;
}
`;

test("pi-multi-auth starts startup warmup only after session_start", () => {
	const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", childScript], {
		cwd: distRoot,
		env: {
			...process.env,
			PI_MULTI_AUTH_DIST_ROOT: distRoot,
		},
		encoding: "utf-8",
	});

	const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}");

	assert.equal(result.ensureCallsAfterLoad, 0);
	assert.equal(result.ensureCallsBeforeSessionStart, 0);
	assert.equal(result.ensureCallsAfterSessionStart, 1);
	assert.equal(result.autoActivateCallsBeforeRelease, 0);
	assert.deepEqual(result.autoActivateCallOptions, [{ avoidUsageApi: true }]);
});

test("delegated subagent runtime resolves the router-provided credential override", () => {
	const override = resolveDelegatedCredentialOverride("openai-codex", {
		[PI_AGENT_ROUTER_SUBAGENT_ENV]: "1",
		[PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID_ENV]: "openai-codex",
		[PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID_ENV]: "openai-codex-4",
		[PI_AGENT_ROUTER_DELEGATED_API_KEY_ENV]: "delegated-secret",
	});

	assert.deepEqual(override, {
		providerId: "openai-codex",
		credentialId: "openai-codex-4",
		apiKey: "delegated-secret",
	});
	assert.equal(
		resolveDelegatedCredentialOverride("github-copilot", {
			[PI_AGENT_ROUTER_SUBAGENT_ENV]: "1",
			[PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID_ENV]: "openai-codex",
			[PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID_ENV]: "openai-codex-4",
			[PI_AGENT_ROUTER_DELEGATED_API_KEY_ENV]: "delegated-secret",
		}),
		undefined,
	);
});

test("multi-auth config initializes with documented module defaults", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-config-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const configPath = join(tempRoot, "config.json");
	const configResult = loadMultiAuthConfig(configPath);
	const configContent = await readFile(configPath, "utf-8");

	assert.equal(configResult.created, true);
	assert.deepEqual(configResult.config, DEFAULT_MULTI_AUTH_CONFIG);
	assert.equal(configResult.warning, undefined);
	assert.match(configContent, /"debug": false/);
	assert.match(configContent, /"cascade": \{/);
	assert.match(configContent, /"health": \{/);
	assert.match(configContent, /"historyPersistence": \{/);
	assert.match(configContent, /"oauthRefresh": \{/);
	assert.match(configContent, /"excludedProviders": \[\]/);
});


test("multi-auth config validates nested documented options and falls back with warnings", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-config-invalid-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const configPath = join(tempRoot, "config.json");
	await writeFile(
		configPath,
		JSON.stringify(
			{
				debug: "yes",
				excludeProviders: ["openai-codex", 42, "   ", "anthropic"],
				cascade: {
					initialBackoffMs: -1,
					maxBackoffMs: 10,
					backoffMultiplier: 0,
					maxHistoryEntries: 0,
				},
				health: {
					windowSize: 0,
					maxLatencyMs: 0,
					uptimeWindowMs: -1,
					minRequests: 0,
					staleThresholdMs: 0,
					weights: {
						successRate: -1,
						latencyFactor: 0,
						uptimeFactor: 0,
						recoveryFactor: 0,
					},
				},
				historyPersistence: {
					enabled: "always",
					healthFileName: "../health.txt",
					cascadeFileName: " nested/cascade.json ",
				},
				oauthRefresh: {
					safetyWindowMs: -1,
					minRefreshWindowMs: -1,
					checkIntervalMs: 0,
					maxConcurrentRefreshes: 0,
					enabled: "sometimes",
					excludedProviders: ["cline", 42, "   "],
				},
			},
			null,
			2,
		),
		"utf-8",
	);

	const configResult = loadMultiAuthConfig(configPath);

	assert.deepEqual(configResult.config.excludeProviders, ["openai-codex", "anthropic"]);
	assert.deepEqual(configResult.config.cascade, {
		...DEFAULT_MULTI_AUTH_CONFIG.cascade,
		maxBackoffMs: DEFAULT_MULTI_AUTH_CONFIG.cascade.initialBackoffMs,
	});
	assert.deepEqual(configResult.config.health, {
		...DEFAULT_MULTI_AUTH_CONFIG.health,
		weights: {
			...DEFAULT_MULTI_AUTH_CONFIG.health.weights,
			latencyFactor: 0,
			uptimeFactor: 0,
			recoveryFactor: 0,
		},
	});
	assert.deepEqual(
		configResult.config.historyPersistence,
		DEFAULT_MULTI_AUTH_CONFIG.historyPersistence,
	);
	assert.deepEqual(configResult.config.oauthRefresh, {
		...DEFAULT_MULTI_AUTH_CONFIG.oauthRefresh,
		excludedProviders: ["cline"],
	});
	assert.match(configResult.warning ?? "", /debug/);
	assert.match(configResult.warning ?? "", /excludeProviders/);
	assert.match(configResult.warning ?? "", /cascade\.initialBackoffMs/);
	assert.match(configResult.warning ?? "", /health\.weights/);
	assert.match(configResult.warning ?? "", /historyPersistence\.enabled/);
	assert.match(configResult.warning ?? "", /historyPersistence\.healthFileName/);
	assert.match(configResult.warning ?? "", /historyPersistence\.cascadeFileName/);
	assert.match(configResult.warning ?? "", /oauthRefresh\.enabled/);
	assert.match(configResult.warning ?? "", /oauthRefresh\.excludedProviders/);
});

test("multi-auth config accepts custom history persistence file names", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-config-history-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const configPath = join(tempRoot, "config.json");
	await writeFile(
		configPath,
		JSON.stringify(
			{
				historyPersistence: {
					enabled: false,
					healthFileName: "custom-health-history.json",
					cascadeFileName: "custom-cascade-history.json",
				},
			},
			null,
			2,
		),
		"utf-8",
	);

	const configResult = loadMultiAuthConfig(configPath);

	assert.deepEqual(configResult.config.historyPersistence, {
		enabled: false,
		healthFileName: "custom-health-history.json",
		cascadeFileName: "custom-cascade-history.json",
	});
	assert.equal(configResult.warning, undefined);
});

test("multi-auth debug logger writes JSONL entries under the debug directory when enabled", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-debug-log-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const configPath = join(tempRoot, "config.json");
	const debugDir = join(tempRoot, "debug");
	const logPath = join(debugDir, "pi-multi-auth-debug.jsonl");
	await writeFile(configPath, JSON.stringify({ debug: true }, null, 2), "utf-8");

	const logger = new MultiAuthDebugLogger({
		configPath,
		debugDir,
		logPath,
	});
	logger.log("auth_lock_wait", {
		authPath: join(tempRoot, "auth.json"),
		attempt: 1,
		maxAttempts: 11,
		delayMs: 100,
	});
	await logger.flush();

	const logContent = await readFile(logPath, "utf-8");
	const firstLine = logContent.trim().split(/\r?\n/)[0] ?? "{}";
	const entry = JSON.parse(firstLine) as Record<string, unknown>;

	assert.equal(entry.extension, "pi-multi-auth");
	assert.equal(entry.level, "debug");
	assert.equal(entry.event, "auth_lock_wait");
	assert.equal(entry.attempt, 1);
	assert.equal(entry.maxAttempts, 11);
});

test("account manager initializes lazily when credentials are first acquired", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-account-manager-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const providerId = "test-provider";

	await writeFile(
		authPath,
		JSON.stringify(
			{
				"test-provider": { type: "api_key", key: " alpha " },
				"test-provider-7": { type: "api_key", key: "beta" },
			},
			null,
			2,
		),
		"utf-8",
	);
	await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");

	const authWriter = new AuthWriter(authPath);
	const storage = new MultiAuthStorage(storagePath);
	const usageService = new UsageService(undefined, undefined, undefined, undefined, { persistentCache: false });
	const providerRegistry = new ProviderRegistry(authWriter, modelsPath, [providerId]);
	const accountManager = new AccountManager(authWriter, storage, usageService, providerRegistry);

	const selected = await accountManager.acquireCredential(providerId);
	const authData = JSON.parse(await readFile(authPath, "utf-8")) as Record<string, unknown>;
	const storageData = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<string, { credentialIds: string[] }>;
	};

	assert.equal(selected.provider, providerId);
	assert.equal(selected.credentialId, providerId);
	assert.equal(selected.secret, "alpha");
	assert.deepEqual(Object.keys(authData).sort(), [providerId, `${providerId}-1`]);
	assert.deepEqual(storageData.providers[providerId]?.credentialIds, [providerId, `${providerId}-1`]);
});

test("account manager can acquire credentials while core auth lock is held for read-only access", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-auth-lock-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const providerId = "openai-codex";
	const futureExpiry = Date.now() + 60 * 60 * 1000;

	await writeFile(
		authPath,
		JSON.stringify(
			{
				[providerId]: {
					type: "oauth",
					access: "dummy-access-token",
					refresh: "dummy-refresh-token",
					expires: futureExpiry,
				},
			},
			null,
			2,
		),
		"utf-8",
	);
	await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");

	const authWriter = new AuthWriter(authPath);
	const storage = new MultiAuthStorage(storagePath);
	const usageService = new UsageService(undefined, undefined, undefined, undefined, { persistentCache: false });
	const providerRegistry = new ProviderRegistry(authWriter, modelsPath, [providerId]);
	const accountManager = new AccountManager(authWriter, storage, usageService, providerRegistry);
	const { FileAuthStorageBackend } = await import(
		pathToFileURL(
			join(
				process.cwd(),
				"node_modules",
				"@mariozechner",
				"pi-coding-agent",
				"dist",
				"core",
				"auth-storage.js",
			),
		).href,
	);
	const backend = new FileAuthStorageBackend(authPath);

	let releaseLock: (() => void) | undefined;
	let resolveLockAcquired: (() => void) | undefined;
	const lockAcquired = new Promise<void>((resolve) => {
		resolveLockAcquired = resolve;
	});
	const holdPromise = backend.withLockAsync(async () => {
		resolveLockAcquired?.();
		await new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		return { result: undefined };
	});
	await lockAcquired;

	try {
		const raceResult = await Promise.race([
			accountManager.acquireCredential(providerId).then((selected) => ({
				type: "selected" as const,
				selected,
			})),
			sleep(1_000).then(() => ({ type: "timeout" as const })),
		]);

		assert.notEqual(
			raceResult.type,
			"timeout",
			"acquireCredential should not block on auth.json when only reading credential state",
		);
		if (raceResult.type !== "selected") {
			assert.fail("Expected credential selection to complete while core auth lock was still held.");
		}

		assert.equal(raceResult.selected.provider, providerId);
		assert.equal(raceResult.selected.credentialId, providerId);
		assert.equal(raceResult.selected.secret, "dummy-access-token");
	} finally {
		releaseLock?.();
		await holdPromise;
	}
});

test("openai-codex defaults to usage-based rotation when provider state is initialized", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-codex-rotation-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const providerId = "openai-codex";
	const futureExpiry = Date.now() + 60 * 60 * 1000;

	await writeFile(
		authPath,
		JSON.stringify(
			{
				[providerId]: {
					type: "oauth",
					access: "dummy-access-token",
					refresh: "dummy-refresh-token",
					expires: futureExpiry,
				},
			},
			null,
			2,
		),
		"utf-8",
	);
	await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");

	const authWriter = new AuthWriter(authPath);
	const storage = new MultiAuthStorage(storagePath);
	const usageService = new UsageService(undefined, undefined, undefined, undefined, { persistentCache: false });
	const providerRegistry = new ProviderRegistry(authWriter, modelsPath, [providerId]);

	const accountManager = new AccountManager(authWriter, storage, usageService, providerRegistry);
	const status = await accountManager.getProviderStatus(providerId);

	assert.equal(status.rotationMode, "usage-based", "openai-codex should default to usage-based rotation");
});
