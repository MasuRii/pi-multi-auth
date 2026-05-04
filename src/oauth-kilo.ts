import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthProviderInterface,
} from "./oauth-compat.js";
import {
	registerOAuthProvider,
	unregisterOAuthProvider,
} from "./oauth-compat.js";
import { fetchWithTimeout } from "./async-utils.js";
import {
	createAbortError,
	isRecord,
	normalizeNonEmptyString,
	throwFixedAbortErrorIfAborted,
} from "./auth-error-utils.js";
import { buildKiloRequestHeaders } from "./kilo-compat.js";
import { OAuthRefreshFailureError } from "./types-oauth.js";

const KILO_PROVIDER_ID = "kilo";
const KILO_PROVIDER_NAME = "Kilo";
const KILO_API_BASE_URL = "https://api.kilo.ai";
const DEVICE_AUTH_CODES_PATH = "/api/device-auth/codes";
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_TOKEN_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const KILO_OAUTH_CANCELLED_MESSAGE = "Kilo OAuth login was cancelled.";

type DeviceAuthStatus = "pending" | "approved" | "denied" | "expired";

interface DeviceAuthResponse {
	code: string;
	verificationUrl: string;
	expiresIn: number;
}

interface DeviceAuthPollResponse {
	status: DeviceAuthStatus;
	token?: string;
}

export interface KiloOAuthProviderDependencies {
	fetchImplementation: typeof fetch;
	baseUrl: string;
	pollIntervalMs: number;
	tokenExpirationMs: number;
	requestTimeoutMs: number;
	now: () => number;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function createJsonHeaders(): HeadersInit {
	return {
		"Content-Type": "application/json",
		...buildKiloRequestHeaders(),
	};
}

function resolvePositiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function createEndpoint(baseUrl: string, path: string): URL {
	return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError(KILO_OAUTH_CANCELLED_MESSAGE));
			return;
		}

		const onAbort = (): void => {
			clearTimeout(timeout);
			reject(createAbortError(KILO_OAUTH_CANCELLED_MESSAGE));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown> | null> {
	const parsed = (await response.json().catch(() => null)) as unknown;
	return isRecord(parsed) ? parsed : null;
}

function parseDeviceAuthResponse(payload: Record<string, unknown> | null): DeviceAuthResponse {
	const code = normalizeNonEmptyString(payload?.code);
	const verificationUrl = normalizeNonEmptyString(payload?.verificationUrl);
	const expiresIn = payload?.expiresIn;
	if (!code || !verificationUrl || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
		throw new Error("Kilo device authorization response was missing required fields.");
	}
	return { code, verificationUrl, expiresIn };
}

function parsePollResponse(
	statusCode: number,
	payload: Record<string, unknown> | null,
): DeviceAuthPollResponse {
	if (statusCode === 202) {
		return { status: "pending" };
	}
	if (statusCode === 403) {
		return { status: "denied" };
	}
	if (statusCode === 410) {
		return { status: "expired" };
	}

	const status = normalizeNonEmptyString(payload?.status);
	const token = normalizeNonEmptyString(payload?.token);
	if (status === "pending" || status === "denied" || status === "expired") {
		return { status };
	}
	if (status === "approved" || token) {
		return { status: "approved", token };
	}
	throw new Error("Kilo device authorization poll response was missing required fields.");
}

async function initiateDeviceAuth(
	dependencies: KiloOAuthProviderDependencies,
	signal: AbortSignal | undefined,
): Promise<DeviceAuthResponse> {
	const response = await fetchWithTimeout(
		createEndpoint(dependencies.baseUrl, DEVICE_AUTH_CODES_PATH),
		{
			method: "POST",
			headers: createJsonHeaders(),
		},
		{
			fetchImplementation: dependencies.fetchImplementation,
			timeoutMs: dependencies.requestTimeoutMs,
			signal,
			abortMessage: KILO_OAUTH_CANCELLED_MESSAGE,
		},
	);
	if (!response.ok) {
		throw new Error(
			response.status === 429
				? "Too many pending Kilo authorization requests. Please try again later."
				: `Failed to initiate Kilo device authorization: ${response.status}`,
		);
	}
	return parseDeviceAuthResponse(await readJsonRecord(response));
}

async function pollDeviceAuth(
	dependencies: KiloOAuthProviderDependencies,
	code: string,
	signal: AbortSignal | undefined,
): Promise<DeviceAuthPollResponse> {
	const response = await fetchWithTimeout(
		createEndpoint(dependencies.baseUrl, `${DEVICE_AUTH_CODES_PATH}/${encodeURIComponent(code)}`),
		{
			method: "GET",
			headers: buildKiloRequestHeaders(),
		},
		{
			fetchImplementation: dependencies.fetchImplementation,
			timeoutMs: dependencies.requestTimeoutMs,
			signal,
			abortMessage: KILO_OAUTH_CANCELLED_MESSAGE,
		},
	);
	const payload = await readJsonRecord(response);
	if (!response.ok && response.status !== 202 && response.status !== 403 && response.status !== 410) {
		throw new Error(`Failed to poll Kilo device authorization: ${response.status}`);
	}
	return parsePollResponse(response.status, payload);
}

async function loginKilo(
	callbacks: OAuthLoginCallbacks,
	dependencies: KiloOAuthProviderDependencies,
): Promise<OAuthCredentials> {
	throwFixedAbortErrorIfAborted(callbacks.signal, KILO_OAUTH_CANCELLED_MESSAGE);
	callbacks.onProgress?.("Initiating Kilo device authorization...");
	const { code, verificationUrl, expiresIn } = await initiateDeviceAuth(
		dependencies,
		callbacks.signal,
	);

	callbacks.onAuth({
		url: verificationUrl,
		instructions: `Enter code: ${code}`,
	});
	callbacks.onProgress?.("Waiting for Kilo browser authorization...");

	const deadline = dependencies.now() + expiresIn * 1000;
	while (dependencies.now() < deadline) {
		throwFixedAbortErrorIfAborted(callbacks.signal, KILO_OAUTH_CANCELLED_MESSAGE);
		await dependencies.sleep(dependencies.pollIntervalMs, callbacks.signal);
		const result = await pollDeviceAuth(dependencies, code, callbacks.signal);
		if (result.status === "approved") {
			const token = normalizeNonEmptyString(result.token);
			if (!token) {
				throw new Error("Kilo authorization was approved but did not include a token.");
			}
			callbacks.onProgress?.("Kilo login successful.");
			return {
				access: token,
				refresh: token,
				expires: dependencies.now() + dependencies.tokenExpirationMs,
				provider: KILO_PROVIDER_ID,
			};
		}
		if (result.status === "denied") {
			throw new Error("Kilo authorization was denied by the user.");
		}
		if (result.status === "expired") {
			throw new Error("Kilo authorization code expired. Please try again.");
		}

		const remainingSeconds = Math.max(0, Math.ceil((deadline - dependencies.now()) / 1000));
		callbacks.onProgress?.(
			`Waiting for Kilo browser authorization... (${remainingSeconds}s remaining)`,
		);
	}
	throw new Error("Kilo authentication timed out. Please try again.");
}

async function refreshKiloCredentials(
	credentials: OAuthCredentials,
	now: () => number,
): Promise<OAuthCredentials> {
	if (credentials.expires > now()) {
		return credentials;
	}
	throw new OAuthRefreshFailureError(
		"Kilo OAuth token expired. Please run OAuth login for Kilo again.",
		{
			providerId: KILO_PROVIDER_ID,
			reason: "token_expired_reauthentication_required",
			permanent: true,
			source: "extension",
		},
	);
}

export function createKiloOAuthProvider(
	dependencies: Partial<KiloOAuthProviderDependencies> = {},
): OAuthProviderInterface {
	const resolvedDependencies: KiloOAuthProviderDependencies = {
		fetchImplementation: dependencies.fetchImplementation ?? fetch,
		baseUrl: normalizeNonEmptyString(dependencies.baseUrl) ?? KILO_API_BASE_URL,
		pollIntervalMs: resolvePositiveInteger(dependencies.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
		tokenExpirationMs: resolvePositiveInteger(
			dependencies.tokenExpirationMs,
			DEFAULT_TOKEN_EXPIRATION_MS,
		),
		requestTimeoutMs: resolvePositiveInteger(
			dependencies.requestTimeoutMs,
			DEFAULT_REQUEST_TIMEOUT_MS,
		),
		now: dependencies.now ?? (() => Date.now()),
		sleep: dependencies.sleep ?? defaultSleep,
	};

	return {
		id: KILO_PROVIDER_ID,
		name: KILO_PROVIDER_NAME,
		usesCallbackServer: false,
		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			return loginKilo(callbacks, resolvedDependencies);
		},
		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			return refreshKiloCredentials(credentials, resolvedDependencies.now);
		},
		getApiKey(credentials: OAuthCredentials): string {
			const accessToken = normalizeNonEmptyString(credentials.access);
			if (!accessToken) {
				throw new Error("Kilo OAuth credentials are missing an access token.");
			}
			return accessToken;
		},
	};
}

export const kiloOAuthProvider = createKiloOAuthProvider();

export function registerKiloOAuthProvider(): void {
	registerOAuthProvider(kiloOAuthProvider);
}

export function unregisterKiloOAuthProvider(): void {
	unregisterOAuthProvider(KILO_PROVIDER_ID);
}
