import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthWriter } from "../src/auth-writer.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { MultiAuthStorage } from "../src/storage.js";

async function withEnv<T>(
	overrides: Record<string, string | undefined>,
	fn: () => Promise<T> | T,
): Promise<T> {
	const previous = new Map<string, string | undefined>();

	for (const [key, value] of Object.entries(overrides)) {
		previous.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	try {
		return await fn();
	} finally {
		for (const [key, value] of previous.entries()) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

test("pi-multi-auth uses PI_CODING_AGENT_DIR for delegated runtime state", async () => {
	const tmpHome = mkdtempSync(join(tmpdir(), "pi-multi-auth-home-"));
	const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-multi-auth-runtime-"));
	const runtimeModelsPath = join(runtimeRoot, "models.json");
	const runtimeAuthPath = join(runtimeRoot, "auth.json");
	const runtimeStoragePath = join(runtimeRoot, "multi-auth.json");

	writeFileSync(
		runtimeModelsPath,
		JSON.stringify(
			{
				providers: {
					"runtime-provider": {
						api: "openai",
						baseUrl: "https://example.com/runtime",
						models: [{ id: "runtime-model" }],
					},
				},
			},
			null,
			2,
		),
		"utf-8",
	);

	await withEnv(
		{
			HOME: tmpHome,
			USERPROFILE: tmpHome,
			PI_CODING_AGENT_DIR: runtimeRoot,
		},
		async () => {
			const authWriter = new AuthWriter();
			const storage = new MultiAuthStorage();
			const registry = new ProviderRegistry();

			assert.equal(authWriter.getPath(), runtimeAuthPath);
			assert.equal(storage.getPath(), runtimeStoragePath);

			await authWriter.setApiKeyCredential("runtime-provider", " runtime-secret ");
			const state = await storage.read();
			const metadata = await registry.resolveProviderRegistrationMetadata("runtime-provider");
			const providers = await registry.discoverProviderIds();

			assert.equal(state.version, 1);
			assert.equal(existsSync(runtimeAuthPath), true);
			assert.equal(existsSync(runtimeStoragePath), true);
			assert.equal(existsSync(join(tmpHome, ".pi", "agent", "auth.json")), false);
			assert.equal(existsSync(join(tmpHome, ".pi", "agent", "multi-auth.json")), false);
			assert.match(readFileSync(runtimeAuthPath, "utf-8"), /"key": "runtime-secret"/);
			assert.equal(metadata?.baseUrl, "https://example.com/runtime");
			assert.equal(metadata?.models[0]?.id, "runtime-model");
			assert.equal(providers.includes("runtime-provider"), true);
		},
	);
});

test("pi-multi-auth falls back to HOME-based runtime paths without isolation", async () => {
	const tmpHome = mkdtempSync(join(tmpdir(), "pi-multi-auth-home-fallback-"));
	const homeAgentDir = join(tmpHome, ".pi", "agent");
	const homeModelsPath = join(homeAgentDir, "models.json");
	const homeAuthPath = join(homeAgentDir, "auth.json");
	const homeStoragePath = join(homeAgentDir, "multi-auth.json");
	mkdirSync(homeAgentDir, { recursive: true });

	writeFileSync(
		homeModelsPath,
		JSON.stringify(
			{
				providers: {
					"fallback-provider": {
						api: "openai",
						baseUrl: "https://example.com/fallback",
						models: [{ id: "fallback-model" }],
					},
				},
			},
			null,
			2,
		),
		"utf-8",
	);

	await withEnv(
		{
			HOME: tmpHome,
			USERPROFILE: tmpHome,
			PI_CODING_AGENT_DIR: undefined,
		},
		async () => {
			const authWriter = new AuthWriter();
			const storage = new MultiAuthStorage();
			const registry = new ProviderRegistry();

			assert.equal(authWriter.getPath(), homeAuthPath);
			assert.equal(storage.getPath(), homeStoragePath);

			await authWriter.setApiKeyCredential("fallback-provider", " fallback-secret ");
			await storage.read();
			const metadata = await registry.resolveProviderRegistrationMetadata("fallback-provider");

			assert.equal(existsSync(homeAuthPath), true);
			assert.equal(existsSync(homeStoragePath), true);
			assert.match(readFileSync(homeAuthPath, "utf-8"), /"key": "fallback-secret"/);
			assert.equal(metadata?.baseUrl, "https://example.com/fallback");
			assert.equal(metadata?.models[0]?.id, "fallback-model");
		},
	);
});
