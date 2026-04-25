import { createServer, type Server } from "node:http";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthProviderInterface,
} from "./oauth-compat.js";
import {
	registerOAuthProvider,
	unregisterOAuthProvider,
} from "./oauth-compat.js";
import { buildClineClientHeaders } from "./cline-compat.js";
import {
	OAuthRefreshFailureError,
	type OAuthRefreshFailureDetails,
} from "./types-oauth.js";

const CLINE_PROVIDER_ID = "cline";
const CLINE_PROVIDER_NAME = "Cline";
const CLINE_API_BASE_URL = "https://api.cline.bot";
const CLINE_AUTHORIZE_ENDPOINT = "/api/v1/auth/authorize";
const CLINE_TOKEN_ENDPOINT = "/api/v1/auth/token";
const CLINE_REFRESH_ENDPOINT = "/api/v1/auth/refresh";
const CLINE_CALLBACK_PATH = "/auth";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT_RANGE_START = 48_801;
const CALLBACK_PORT_RANGE_END = 48_811;
const MANUAL_CALLBACK_PROMPT = "Paste the Cline callback URL or authorization code:";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const AUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Cline Authentication Complete</title>
</head>
<body>
  <h1>Authentication successful</h1>
  <p>You can return to Pi now.</p>
</body>
</html>`;

const AUTH_ERROR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Cline Authentication Error</title>
</head>
<body>
  <h1>Authentication callback error</h1>
  <p>Please return to Pi and paste the full callback URL manually.</p>
</body>
</html>`;

type ClineAuthApiUser = {
	subject?: string | null;
	email?: string;
	name?: string;
	clineUserId?: string | null;
	accounts?: string[] | null;
};

type ClineAuthResponseData = {
	accessToken?: string;
	refreshToken?: string;
	tokenType?: string;
	expiresAt?: string;
	userInfo?: ClineAuthApiUser;
};

type ClineAuthResponse = {
	success?: boolean;
	data?: ClineAuthResponseData;
	error?: string;
	error_description?: string;
	redirect_url?: string;
};

type ParsedAuthorizationInput = {
	code?: string;
	provider?: string;
};

export interface LocalCallbackServerHandle {
	callbackUrl: string;
	waitForCallback(): Promise<string | null>;
	cancelWait(): void;
	close(): Promise<void>;
}

export interface ClineOAuthProviderDependencies {
	fetchImplementation: typeof fetch;
	startLocalCallbackServer: () => Promise<LocalCallbackServerHandle>;
	requestTimeoutMs: number;
	now: () => number;
}

function normalizeNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createRefreshFailureDetails(
	status: number | undefined,
	errorCode: string | undefined,
	reason: string,
	permanent: boolean,
): OAuthRefreshFailureDetails {
	return {
		providerId: CLINE_PROVIDER_ID,
		status,
		errorCode,
		reason,
		permanent,
		source: "extension",
	};
}

function parseAuthorizationInput(input: string): ParsedAuthorizationInput {
	const value = input.trim();
	if (!value) {
		return {};
	}

	try {
		const url = new URL(value);
		return {
			code:
				normalizeNonEmptyString(url.searchParams.get("refreshToken") ?? undefined) ??
				normalizeNonEmptyString(url.searchParams.get("idToken") ?? undefined) ??
				normalizeNonEmptyString(url.searchParams.get("code") ?? undefined),
			provider: normalizeNonEmptyString(url.searchParams.get("provider") ?? undefined),
		};
	} catch {
		// Ignore URL parsing errors and fall back to plain-text parsing.
	}

	if (value.includes("code=") || value.includes("refreshToken=") || value.includes("idToken=")) {
		const params = new URLSearchParams(value);
		return {
			code:
				normalizeNonEmptyString(params.get("refreshToken") ?? undefined) ??
				normalizeNonEmptyString(params.get("idToken") ?? undefined) ??
				normalizeNonEmptyString(params.get("code") ?? undefined),
			provider: normalizeNonEmptyString(params.get("provider") ?? undefined),
		};
	}

	return {
		code: value,
	};
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
	if (!text.trim()) {
		return null;
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function resolveExpirationTimestamp(expiresAtIso: string | undefined, fallbackToken: string): number {
	const parsedTimestamp = typeof expiresAtIso === "string" ? Date.parse(expiresAtIso) : Number.NaN;
	if (Number.isFinite(parsedTimestamp) && parsedTimestamp > 0) {
		return parsedTimestamp;
	}

	const tokenParts = fallbackToken.split(".");
	if (tokenParts.length === 3 && tokenParts[1]) {
		try {
			const payload = JSON.parse(
				Buffer.from(tokenParts[1], "base64").toString("utf-8"),
			) as { exp?: unknown };
			if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
				return payload.exp * 1000;
			}
		} catch {
			// Fall through to default expiration.
		}
	}

	return Date.now() + 60 * 60_000;
}

function createStoredCredentials(
	responseData: ClineAuthResponseData,
	now: () => number,
): OAuthCredentials {
	const accessToken = normalizeNonEmptyString(responseData.accessToken);
	const refreshToken = normalizeNonEmptyString(responseData.refreshToken);
	if (!accessToken || !refreshToken) {
		throw new Error("Cline token response did not include both accessToken and refreshToken.");
	}

	const userInfo = responseData.userInfo ?? {};
	const accountId =
		normalizeNonEmptyString(userInfo.clineUserId) ?? normalizeNonEmptyString(userInfo.subject);
	const email = normalizeNonEmptyString(userInfo.email);
	const displayName = normalizeNonEmptyString(userInfo.name);

	return {
		access: accessToken,
		refresh: refreshToken,
		expires: resolveExpirationTimestamp(responseData.expiresAt, accessToken),
		accountId,
		provider: CLINE_PROVIDER_ID,
		startedAt: now(),
		userInfo: {
			id: accountId,
			email,
			displayName,
			subject: normalizeNonEmptyString(userInfo.subject),
			accounts: Array.isArray(userInfo.accounts)
				? userInfo.accounts.filter((value): value is string => typeof value === "string")
				: [],
		},
	};
}

function createRequestHeaders(): HeadersInit {
	return buildClineClientHeaders({ includeJsonContentType: true });
}

async function readResponsePayload(response: Response): Promise<{
	text: string;
	json: Record<string, unknown> | null;
}> {
	const text = await response.text().catch(() => "");
	return {
		text,
		json: parseJsonRecord(text),
	};
}

async function fetchWithTimeout(
	fetchImplementation: typeof fetch,
	input: RequestInfo | URL,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort();
	}, timeoutMs);

	try {
		return await fetchImplementation(input, {
			...init,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeoutId);
	}
}

async function requestAuthorizeRedirectUrl(
	fetchImplementation: typeof fetch,
	callbackUrl: string,
	requestTimeoutMs: number,
): Promise<string> {
	const url = new URL(CLINE_AUTHORIZE_ENDPOINT, CLINE_API_BASE_URL);
	url.searchParams.set("client_type", "extension");
	url.searchParams.set("callback_url", callbackUrl);
	url.searchParams.set("redirect_uri", callbackUrl);

	const response = await fetchWithTimeout(
		fetchImplementation,
		url,
		{
			method: "GET",
			headers: createRequestHeaders(),
			redirect: "manual",
		},
		requestTimeoutMs,
	);

	if (response.status >= 300 && response.status < 400) {
		const redirectUrl = normalizeNonEmptyString(response.headers.get("Location") ?? undefined);
		if (redirectUrl) {
			return redirectUrl;
		}
	}

	const payload = (await response.json().catch(() => null)) as ClineAuthResponse | null;
	const redirectUrl = normalizeNonEmptyString(payload?.redirect_url);
	if (redirectUrl) {
		return redirectUrl;
	}

	throw new Error("Cline authorization did not return a redirect URL.");
}

async function exchangeAuthorizationCode(
	fetchImplementation: typeof fetch,
	code: string,
	callbackUrl: string,
	provider: string | undefined,
	now: () => number,
	requestTimeoutMs: number,
): Promise<OAuthCredentials> {
	const body: Record<string, string> = {
		grant_type: "authorization_code",
		code,
		client_type: "extension",
		redirect_uri: callbackUrl,
	};
	if (provider) {
		body.provider = provider;
	}

	const response = await fetchWithTimeout(
		fetchImplementation,
		new URL(CLINE_TOKEN_ENDPOINT, CLINE_API_BASE_URL),
		{
			method: "POST",
			headers: createRequestHeaders(),
			body: JSON.stringify(body),
		},
		requestTimeoutMs,
	);

	const payload = (await response.json().catch(() => null)) as ClineAuthResponse | null;
	if (!response.ok || !payload?.success || !payload.data) {
		const message =
			normalizeNonEmptyString(payload?.error_description) ??
			normalizeNonEmptyString(payload?.error) ??
			"Failed to exchange the Cline authorization code for OAuth credentials.";
		throw new Error(message);
	}

	return createStoredCredentials(payload.data, now);
}

async function refreshStoredCredentials(
	fetchImplementation: typeof fetch,
	credentials: OAuthCredentials,
	now: () => number,
	requestTimeoutMs: number,
): Promise<OAuthCredentials> {
	const refreshToken = normalizeNonEmptyString(credentials.refresh);
	if (!refreshToken) {
		throw new OAuthRefreshFailureError(
			"Cline OAuth credentials are missing a refresh token.",
			createRefreshFailureDetails(undefined, undefined, "missing_refresh_token", true),
		);
	}

	let response: Response;
	try {
		response = await fetchWithTimeout(
			fetchImplementation,
			new URL(CLINE_REFRESH_ENDPOINT, CLINE_API_BASE_URL),
			{
				method: "POST",
				headers: createRequestHeaders(),
				body: JSON.stringify({
					refreshToken,
					grantType: "refresh_token",
				}),
			},
			requestTimeoutMs,
		);
	} catch (error) {
		throw new OAuthRefreshFailureError(
			"Cline token refresh request failed.",
			createRefreshFailureDetails(undefined, undefined, "request_failed", false),
			{ cause: error },
		);
	}

	const payload = (await response.json().catch(() => null)) as ClineAuthResponse | null;
	if (!response.ok || !payload?.success || !payload.data) {
		const status = response.status;
		const errorCode = normalizeNonEmptyString(payload?.error);
		const permanent = status === 400 || status === 401;
		throw new OAuthRefreshFailureError(
			normalizeNonEmptyString(payload?.error_description) ??
				normalizeNonEmptyString(payload?.error) ??
				"Cline token refresh failed.",
			createRefreshFailureDetails(
				status,
				errorCode,
				permanent ? "token_rejected" : "http_error",
				permanent,
			),
		);
	}

	const refreshed = createStoredCredentials(payload.data, now);
	return {
		...credentials,
		...refreshed,
		accountId:
			normalizeNonEmptyString(refreshed.accountId) ??
			normalizeNonEmptyString(credentials.accountId),
	};
}

function createAbortError(): Error {
	const error = new Error("Cline OAuth login was cancelled.");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw createAbortError();
	}
}

function fallbackCallbackUrl(): string {
	return `http://${CALLBACK_HOST}:${CALLBACK_PORT_RANGE_START}${CLINE_CALLBACK_PATH}`;
}

async function requestManualAuthorizationInput(callbacks: OAuthLoginCallbacks): Promise<string> {
	if (callbacks.onManualCodeInput) {
		return callbacks.onManualCodeInput();
	}
	return callbacks.onPrompt({
		message: MANUAL_CALLBACK_PROMPT,
		placeholder: fallbackCallbackUrl(),
	});
}

async function resolveAuthorizationInput(
	callbacks: OAuthLoginCallbacks,
	server: LocalCallbackServerHandle,
): Promise<string> {
	const serverResultPromise = server.waitForCallback().then((value) =>
		value ? { source: "server" as const, value } : null,
	);
	const manualResultPromise = requestManualAuthorizationInput(callbacks).then((value) => ({
		source: "manual" as const,
		value,
	}));

	const firstResult = await Promise.race([serverResultPromise, manualResultPromise]);
	if (firstResult) {
		if (firstResult.source === "manual") {
			server.cancelWait();
		}
		return firstResult.value;
	}

	return requestManualAuthorizationInput(callbacks);
}

async function closeServerSafely(server: LocalCallbackServerHandle | null): Promise<void> {
	if (!server) {
		return;
	}
	try {
		await server.close();
	} catch {
		// Ignore callback server shutdown errors.
	}
}

async function listenOnPort(server: Server, port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error & { code?: string }) => {
			server.off("error", onError);
			reject(error);
		};
		server.once("error", onError);
		server.listen(port, CALLBACK_HOST, () => {
			server.off("error", onError);
			resolve();
		});
	});
}

async function startDefaultLocalCallbackServer(): Promise<LocalCallbackServerHandle> {
	let settled = false;
	let settleWait: ((value: string | null) => void) | null = null;
	const callbackPromise = new Promise<string | null>((resolve) => {
		settleWait = (value) => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(value);
		};
	});

	const server = createServer((request, response) => {
		const requestUrl = new URL(request.url ?? "/", `http://${CALLBACK_HOST}`);
		if (requestUrl.pathname !== CLINE_CALLBACK_PATH) {
			response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
			response.end(AUTH_ERROR_HTML);
			return;
		}

		const fullUrl = `http://${CALLBACK_HOST}:${boundPort}${request.url ?? ""}`;
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(AUTH_SUCCESS_HTML);
		settleWait?.(fullUrl);
	});

	let boundPort = CALLBACK_PORT_RANGE_START;
	let lastError: Error | null = null;
	for (let port = CALLBACK_PORT_RANGE_START; port <= CALLBACK_PORT_RANGE_END; port += 1) {
		try {
			await listenOnPort(server, port);
			boundPort = port;
			lastError = null;
			break;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if ((lastError as Error & { code?: string }).code !== "EADDRINUSE") {
				throw lastError;
			}
		}
	}
	if (lastError) {
		throw lastError;
	}

	return {
		callbackUrl: `http://${CALLBACK_HOST}:${boundPort}${CLINE_CALLBACK_PATH}`,
		waitForCallback: async () => callbackPromise,
		cancelWait: () => {
			settleWait?.(null);
		},
		close: async () => {
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			});
		},
	};
}

export function createClineOAuthProvider(
	dependencies: Partial<ClineOAuthProviderDependencies> = {},
): OAuthProviderInterface {
	const resolvedDependencies: ClineOAuthProviderDependencies = {
		fetchImplementation: dependencies.fetchImplementation ?? fetch,
		startLocalCallbackServer:
			dependencies.startLocalCallbackServer ?? startDefaultLocalCallbackServer,
		requestTimeoutMs:
			typeof dependencies.requestTimeoutMs === "number" &&
			Number.isFinite(dependencies.requestTimeoutMs) &&
			dependencies.requestTimeoutMs > 0
				? Math.floor(dependencies.requestTimeoutMs)
				: DEFAULT_REQUEST_TIMEOUT_MS,
		now: dependencies.now ?? (() => Date.now()),
	};

	return {
		id: CLINE_PROVIDER_ID,
		name: CLINE_PROVIDER_NAME,
		usesCallbackServer: true,
		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			throwIfAborted(callbacks.signal);

			let callbackServer: LocalCallbackServerHandle | null = null;
			let callbackUrl = fallbackCallbackUrl();
			try {
				callbackServer = await resolvedDependencies.startLocalCallbackServer();
				callbackUrl = callbackServer.callbackUrl;
			} catch {
				callbackServer = {
					callbackUrl,
					waitForCallback: async () => null,
					cancelWait: () => {},
					close: async () => {},
				};
			}

			try {
				callbacks.onProgress?.("Requesting Cline authorization URL...");
				const authUrl = await requestAuthorizeRedirectUrl(
					resolvedDependencies.fetchImplementation,
					callbackUrl,
					resolvedDependencies.requestTimeoutMs,
				);
				throwIfAborted(callbacks.signal);
				callbacks.onAuth({
					url: authUrl,
					instructions:
						"Complete the browser sign-in. If Pi does not capture the callback automatically, paste the final callback URL or authorization code here.",
				});

				callbacks.onProgress?.("Waiting for Cline authentication callback...");
				const rawInput = await resolveAuthorizationInput(callbacks, callbackServer);
				throwIfAborted(callbacks.signal);
				const parsedInput = parseAuthorizationInput(rawInput);
				const code = normalizeNonEmptyString(parsedInput.code);
				if (!code) {
					throw new Error("Cline OAuth login requires an authorization code or callback URL.");
				}

				callbacks.onProgress?.("Exchanging Cline authorization code...");
				return await exchangeAuthorizationCode(
					resolvedDependencies.fetchImplementation,
					code,
					callbackUrl,
					parsedInput.provider,
					resolvedDependencies.now,
					resolvedDependencies.requestTimeoutMs,
				);
			} finally {
				await closeServerSafely(callbackServer);
			}
		},
		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			return refreshStoredCredentials(
				resolvedDependencies.fetchImplementation,
				credentials,
				resolvedDependencies.now,
				resolvedDependencies.requestTimeoutMs,
			);
		},
		getApiKey(credentials: OAuthCredentials): string {
			const accessToken = normalizeNonEmptyString(credentials.access);
			if (!accessToken) {
				throw new Error("Cline OAuth credentials are missing an access token.");
			}
			return `workos:${accessToken}`;
		},
	};
}

export const clineOAuthProvider = createClineOAuthProvider();

export function registerClineOAuthProvider(): void {
	registerOAuthProvider(clineOAuthProvider);
}

export function unregisterClineOAuthProvider(): void {
	unregisterOAuthProvider(CLINE_PROVIDER_ID);
}
