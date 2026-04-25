import test from "node:test";
import assert from "node:assert/strict";
import {
	createClineOAuthProvider,
	registerClineOAuthProvider,
} from "../src/oauth-cline.js";
import {
	getOAuthProvider,
	resetOAuthProviders,
} from "../src/oauth-compat.js";
import type { OAuthLoginCallbacks } from "../src/oauth-compat.js";

function createLoginCallbacks(
	manualInput: string,
): OAuthLoginCallbacks & {
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
		onPrompt: async () => manualInput,
		onManualCodeInput: async () => manualInput,
		onProgress: (message) => {
			progressMessages.push(message);
		},
	};
}

test.afterEach(() => {
	resetOAuthProviders();
});

test("registerClineOAuthProvider exposes a Cline OAuth provider with workos API keys", () => {
	registerClineOAuthProvider();
	const provider = getOAuthProvider("cline");

	assert.ok(provider, "expected Cline OAuth provider to be registered");
	assert.equal(provider?.id, "cline");
	assert.equal(provider?.getApiKey({ access: "token", refresh: "refresh", expires: 1 }), "workos:token");
});

test("createClineOAuthProvider exchanges a callback URL for OAuth credentials", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const provider = createClineOAuthProvider({
		fetchImplementation: async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.includes("/api/v1/auth/authorize")) {
				return new Response(JSON.stringify({ redirect_url: "https://auth.example.test/login" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/v1/auth/token")) {
				return new Response(
					JSON.stringify({
						success: true,
						data: {
							accessToken: "access-token",
							refreshToken: "refresh-token",
							tokenType: "Bearer",
							expiresAt: "2030-01-01T00:00:00.000Z",
							userInfo: {
								clineUserId: "usr_123",
								subject: "subject_123",
								email: "person@example.com",
								name: "Person Example",
								accounts: ["org_123"],
							},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		},
		startLocalCallbackServer: async () => ({
			callbackUrl: "http://127.0.0.1:48801/auth",
			waitForCallback: async () => null,
			cancelWait: () => {},
			close: async () => {},
		}),
	});

	const callbacks = createLoginCallbacks(
		"http://127.0.0.1:48801/auth?code=auth-code-123&provider=github",
	);
	const credentials = await provider.login(callbacks);

	assert.equal(callbacks.authCalls.length, 1);
	assert.equal(callbacks.authCalls[0]?.url, "https://auth.example.test/login");
	assert.match(callbacks.progressMessages.join("\n"), /exchang/i);
	assert.equal(credentials.access, "access-token");
	assert.equal(credentials.refresh, "refresh-token");
	assert.equal(credentials.accountId, "usr_123");
	assert.equal(credentials.provider, "cline");
	assert.equal((credentials.userInfo as { email?: string } | undefined)?.email, "person@example.com");
	assert.ok(typeof credentials.expires === "number" && credentials.expires > Date.now());

	const authorizeRequest = requests[0];
	assert.ok(authorizeRequest, "expected authorize request");
	const authorizeUrl = new URL(authorizeRequest.url);
	assert.equal(authorizeUrl.searchParams.get("client_type"), "extension");
	assert.equal(authorizeUrl.searchParams.get("callback_url"), "http://127.0.0.1:48801/auth");
	assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "http://127.0.0.1:48801/auth");
	const authorizeHeaders = new Headers(authorizeRequest.init?.headers);
	assert.match(authorizeHeaders.get("User-Agent") ?? "", /^Cline\//);
	assert.equal(authorizeHeaders.get("X-CLIENT-TYPE"), "VSCode Extension");

	const tokenRequest = requests[1];
	assert.ok(tokenRequest?.init?.body, "expected token exchange request body");
	const tokenBody = JSON.parse(String(tokenRequest.init.body)) as Record<string, unknown>;
	assert.deepEqual(tokenBody, {
		grant_type: "authorization_code",
		code: "auth-code-123",
		client_type: "extension",
		redirect_uri: "http://127.0.0.1:48801/auth",
		provider: "github",
	});
});

test("createClineOAuthProvider accepts refreshToken and idToken callback parameters", async () => {
	const exchangedCodes: string[] = [];
	const provider = createClineOAuthProvider({
		fetchImplementation: async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/api/v1/auth/authorize")) {
				return new Response(JSON.stringify({ redirect_url: "https://auth.example.test/login" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/v1/auth/token")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { code?: string };
				exchangedCodes.push(body.code ?? "");
				return new Response(
					JSON.stringify({
						success: true,
						data: {
							accessToken: `access-${exchangedCodes.length}`,
							refreshToken: `refresh-${exchangedCodes.length}`,
							tokenType: "Bearer",
							expiresAt: "2030-01-01T00:00:00.000Z",
							userInfo: { clineUserId: "usr_123", email: "person@example.com" },
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		},
		startLocalCallbackServer: async () => ({
			callbackUrl: "http://127.0.0.1:48801/auth",
			waitForCallback: async () => null,
			cancelWait: () => {},
			close: async () => {},
		}),
	});

	await provider.login(createLoginCallbacks("http://127.0.0.1:48801/auth?refreshToken=refresh-callback&provider=github"));
	await provider.login(createLoginCallbacks("http://127.0.0.1:48801/auth?idToken=id-callback&provider=github"));

	assert.deepEqual(exchangedCodes, ["refresh-callback", "id-callback"]);
});

test("createClineOAuthProvider refreshes stored OAuth credentials", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const provider = createClineOAuthProvider({
		fetchImplementation: async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			return new Response(
				JSON.stringify({
					success: true,
					data: {
						accessToken: "refreshed-access-token",
						refreshToken: "refreshed-refresh-token",
						tokenType: "Bearer",
						expiresAt: "2030-01-02T00:00:00.000Z",
						userInfo: {
							clineUserId: "usr_123",
							subject: "subject_123",
							email: "person@example.com",
							name: "Person Example",
							accounts: ["org_123"],
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		},
	});

	const refreshed = await provider.refreshToken({
		access: "old-access-token",
		refresh: "old-refresh-token",
		expires: Date.now() - 1_000,
		accountId: "usr_123",
		userInfo: { email: "person@example.com" },
	});

	assert.equal(refreshed.access, "refreshed-access-token");
	assert.equal(refreshed.refresh, "refreshed-refresh-token");
	assert.equal(refreshed.accountId, "usr_123");
	assert.equal((refreshed.userInfo as { email?: string } | undefined)?.email, "person@example.com");
	assert.ok(typeof refreshed.expires === "number" && refreshed.expires > Date.now());
	assert.equal(provider.getApiKey(refreshed), "workos:refreshed-access-token");

	const refreshRequest = requests[0];
	assert.ok(refreshRequest?.init?.body, "expected refresh request body");
	const refreshBody = JSON.parse(String(refreshRequest.init.body)) as Record<string, unknown>;
	assert.deepEqual(refreshBody, {
		refreshToken: "old-refresh-token",
		grantType: "refresh_token",
	});
});
