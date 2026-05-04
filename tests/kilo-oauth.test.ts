import test from "node:test";
import assert from "node:assert/strict";
import {
	createKiloOAuthProvider,
	registerKiloOAuthProvider,
} from "../src/oauth-kilo.js";
import {
	getOAuthProvider,
	resetOAuthProviders,
} from "../src/oauth-compat.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { OAuthRefreshFailureError } from "../src/types-oauth.js";
import type { OAuthLoginCallbacks } from "../src/oauth-compat.js";

function createLoginCallbacks(): OAuthLoginCallbacks & {
	authCalls: Array<{ url: string; instructions?: string }>;
	progressMessages: string[];
} {
	const authCalls: Array<{ url: string; instructions?: string }> = [];
	const progressMessages: string[] = [];
	return {
		authCalls,
		progressMessages,
		onAuth: (info) => {
			authCalls.push(info);
		},
		onPrompt: async () => "",
		onProgress: (message) => {
			progressMessages.push(message);
		},
	};
}

test.afterEach(() => {
	resetOAuthProviders();
});

test("registerKiloOAuthProvider exposes Kilo OAuth and registry discovery", () => {
	registerKiloOAuthProvider();
	const provider = getOAuthProvider("kilo");
	const registry = new ProviderRegistry();

	assert.ok(provider, "expected Kilo OAuth provider to be registered");
	assert.equal(provider?.id, "kilo");
	assert.equal(provider?.name, "Kilo");
	assert.equal(provider?.usesCallbackServer, false);
	assert.equal(provider?.getApiKey({ access: "kilo-token", refresh: "kilo-token", expires: 1 }), "kilo-token");
	assert.equal(registry.getProviderCapabilities("kilo").supportsOAuth, true);
	assert.ok(registry.listAvailableOAuthProviders().some((entry) => entry.provider === "kilo"));
});

test("createKiloOAuthProvider completes device authorization and stores token credentials", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	let pollCount = 0;
	let now = 1_700_000_000_000;
	const provider = createKiloOAuthProvider({
		baseUrl: "https://kilo.example.test",
		pollIntervalMs: 1,
		tokenExpirationMs: 60_000,
		requestTimeoutMs: 1_000,
		now: () => now,
		sleep: async () => {
			now += 1_000;
		},
		fetchImplementation: async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			if (url === "https://kilo.example.test/api/device-auth/codes") {
				return new Response(
					JSON.stringify({
						code: "ABCD-1234",
						verificationUrl: "https://kilo.example.test/device",
						expiresIn: 120,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://kilo.example.test/api/device-auth/codes/ABCD-1234") {
				pollCount += 1;
				if (pollCount === 1) {
					return new Response("", { status: 202 });
				}
				return new Response(
					JSON.stringify({ status: "approved", token: "kilo-access-token" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		},
	});

	const callbacks = createLoginCallbacks();
	const credentials = await provider.login(callbacks);

	assert.deepEqual(callbacks.authCalls, [
		{
			url: "https://kilo.example.test/device",
			instructions: "Enter code: ABCD-1234",
		},
	]);
	assert.match(callbacks.progressMessages.join("\n"), /Kilo login successful/);
	assert.equal(credentials.access, "kilo-access-token");
	assert.equal(credentials.refresh, "kilo-access-token");
	assert.equal(credentials.provider, "kilo");
	assert.equal(credentials.expires, now + 60_000);
	assert.equal(provider.getApiKey(credentials), "kilo-access-token");

	const initiateHeaders = new Headers(requests[0]?.init?.headers);
	assert.equal(requests[0]?.init?.method, "POST");
	assert.equal(initiateHeaders.get("Content-Type"), "application/json");
	assert.equal(initiateHeaders.get("X-KILOCODE-EDITORNAME"), "Pi");
	const pollHeaders = new Headers(requests[1]?.init?.headers);
	assert.equal(requests[1]?.init?.method, "GET");
	assert.equal(pollHeaders.get("X-KILOCODE-EDITORNAME"), "Pi");
});

test("createKiloOAuthProvider refreshes only unexpired Kilo credentials", async () => {
	const now = Date.now();
	const provider = createKiloOAuthProvider({ now: () => now });
	const activeCredentials = { access: "active", refresh: "active", expires: now + 1_000 };

	assert.equal(await provider.refreshToken(activeCredentials), activeCredentials);
	await assert.rejects(
		() => provider.refreshToken({ access: "expired", refresh: "expired", expires: now - 1 }),
		(error: unknown) =>
			error instanceof OAuthRefreshFailureError &&
			error.details.providerId === "kilo" &&
			error.details.permanent,
	);
});
