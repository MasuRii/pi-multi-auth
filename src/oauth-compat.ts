import {
	getOAuthProvider as getOAuthProviderFromPiAi,
	getOAuthProviders as getOAuthProvidersFromPiAi,
	registerOAuthProvider as registerOAuthProviderFromPiAi,
	resetOAuthProviders as resetOAuthProvidersFromPiAi,
	unregisterOAuthProvider as unregisterOAuthProviderFromPiAi,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
	type OAuthProviderInterface,
} from "@mariozechner/pi-ai/oauth";
import {
	formatOAuthRefreshFailureSummary,
	isRecord,
} from "./auth-error-utils.js";
import { extractCodexCredentialIdentity } from "./openai-codex-identity.js";
import { determineTokenExpiration } from "./oauth-refresh-scheduler.js";
import {
	OAuthRefreshFailureError,
	UNSUPPORTED_OAUTH_REFRESH_PROVIDER_ERROR_CODE,
} from "./types-oauth.js";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_PROVIDER_LABEL = "OpenAI Codex";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;
const OAUTH_REFRESH_TIMEOUT_ERROR_CODE = "request_timeout";

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}


function parseJsonRecord(value: string): Record<string, unknown> | null {
	if (!value.trim()) {
		return null;
	}

	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function extractCodexRefreshErrorDetails(
	parsedBody: Record<string, unknown> | null,
): { errorCode?: string; errorDescription?: string } {
	const nestedError = isRecord(parsedBody?.error) ? parsedBody.error : null;
	return {
		errorCode:
			asNonEmptyString(nestedError?.code) ??
			asNonEmptyString(parsedBody?.error) ??
			asNonEmptyString(nestedError?.type),
		errorDescription:
			asNonEmptyString(nestedError?.message) ??
			asNonEmptyString(parsedBody?.error_description) ??
			asNonEmptyString(parsedBody?.message),
	};
}

function isPermanentCodexRefreshFailure(
	status: number,
	errorCode: string | undefined,
	errorDescription: string | undefined,
	responseBody: string | undefined,
): boolean {
	const combined = [errorCode, errorDescription, responseBody]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.join(" ");

	if (errorCode === "invalid_grant" || errorCode === "refresh_token_reused") {
		return true;
	}

	if (status !== 400 && status !== 401) {
		return false;
	}

	return (
		/invalid[_-]?grant/i.test(combined) ||
		(/refresh token/i.test(combined) &&
			/(expired|revoked|invalid|not found|already(?:\s+been)?\s+used|reused)/i.test(combined))
	);
}

async function fetchCodexRefreshResponse(
	refreshToken: string,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(OPENAI_CODEX_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: OPENAI_CODEX_CLIENT_ID,
			}),
			signal: controller.signal,
		});
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new OAuthRefreshFailureError(
				`OpenAI Codex token refresh request timed out after ${timeoutMs}ms.`,
				{
					providerId: OPENAI_CODEX_PROVIDER_ID,
					permanent: false,
					source: "extension",
					errorCode: OAUTH_REFRESH_TIMEOUT_ERROR_CODE,
				},
				{ cause: error },
			);
		}
		throw new OAuthRefreshFailureError(
			formatOAuthRefreshFailureSummary({
				providerLabel: OPENAI_CODEX_PROVIDER_LABEL,
				reason: "request_failed",
				permanent: false,
				source: "extension",
			}),
			{
				providerId: OPENAI_CODEX_PROVIDER_ID,
				reason: "request_failed",
				permanent: false,
				source: "extension",
			},
			{ cause: error },
		);
	} finally {
		clearTimeout(timeoutId);
	}
}

function createCodexRefreshFailureMessage(
	status: number,
	errorCode: string | undefined,
	permanent: boolean,
): string {
	return formatOAuthRefreshFailureSummary({
		providerLabel: OPENAI_CODEX_PROVIDER_LABEL,
		status,
		errorCode,
		reason: permanent ? "token_rejected" : "http_error",
		permanent,
		source: "extension",
	});
}

async function refreshOpenAICodexCredential(
	credentials: OAuthCredentials,
	requestTimeoutMs: number,
): Promise<OAuthCredentials> {
	const refreshToken = asNonEmptyString(credentials.refresh);
	if (!refreshToken) {
		throw new OAuthRefreshFailureError(
			formatOAuthRefreshFailureSummary({
				providerLabel: OPENAI_CODEX_PROVIDER_LABEL,
				reason: "missing_refresh_token",
				permanent: true,
				source: "extension",
			}),
			{
				providerId: OPENAI_CODEX_PROVIDER_ID,
				reason: "missing_refresh_token",
				permanent: true,
				source: "extension",
			},
		);
	}

	const response = await fetchCodexRefreshResponse(refreshToken, requestTimeoutMs);
	const responseText = await response.text().catch(() => "");
	const parsedBody = parseJsonRecord(responseText);
	const { errorCode, errorDescription } = extractCodexRefreshErrorDetails(parsedBody);

	if (!response.ok) {
		const permanent = isPermanentCodexRefreshFailure(
			response.status,
			errorCode,
			errorDescription,
			responseText,
		);
		throw new OAuthRefreshFailureError(
			createCodexRefreshFailureMessage(response.status, errorCode, permanent),
			{
				providerId: OPENAI_CODEX_PROVIDER_ID,
				status: response.status,
				errorCode,
				reason: permanent ? "token_rejected" : "http_error",
				permanent,
				source: "extension",
			},
		);
	}

	const accessToken = asNonEmptyString(parsedBody?.access_token);
	const nextRefreshToken = asNonEmptyString(parsedBody?.refresh_token);
	const expiresIn =
		typeof parsedBody?.expires_in === "number" && Number.isFinite(parsedBody.expires_in)
			? parsedBody.expires_in
			: undefined;

	if (!accessToken || !nextRefreshToken || expiresIn === undefined) {
		throw new OAuthRefreshFailureError(
			formatOAuthRefreshFailureSummary({
				providerLabel: OPENAI_CODEX_PROVIDER_LABEL,
				reason: "missing_required_fields",
				permanent: false,
				source: "extension",
			}),
			{
				providerId: OPENAI_CODEX_PROVIDER_ID,
				reason: "missing_required_fields",
				permanent: false,
				source: "extension",
			},
		);
	}

	const identity = extractCodexCredentialIdentity({
		access: accessToken,
		accountId: credentials.accountId,
	});
	if (!identity.accountId) {
		throw new OAuthRefreshFailureError(
			formatOAuthRefreshFailureSummary({
				providerLabel: OPENAI_CODEX_PROVIDER_LABEL,
				reason: "missing_account_identity",
				permanent: false,
				source: "extension",
			}),
			{
				providerId: OPENAI_CODEX_PROVIDER_ID,
				reason: "missing_account_identity",
				permanent: false,
				source: "extension",
			},
		);
	}

	const expiration = determineTokenExpiration(accessToken, undefined, expiresIn);
	return {
		...credentials,
		access: accessToken,
		refresh: nextRefreshToken,
		expires: expiration.expiresAt,
		accountId: identity.accountId,
	};
}

/**
 * Runtime-compatible OAuth helpers re-exported from the ESM-only pi-ai OAuth entry.
 *
 * The extension previously used createRequire()/require() to load the helper, but
 * pi-ai publishes the oauth module through import-only package exports. Direct ESM
 * imports work across current Pi builds and avoid ERR_PACKAGE_PATH_NOT_EXPORTED.
 */
export function getOAuthProvider(
	id: OAuthProviderId,
): OAuthProviderInterface | undefined {
	return getOAuthProviderFromPiAi(id);
}

export function getOAuthProviders(): OAuthProviderInterface[] {
	return getOAuthProvidersFromPiAi();
}

export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	registerOAuthProviderFromPiAi(provider);
}

export function unregisterOAuthProvider(id: OAuthProviderId): void {
	unregisterOAuthProviderFromPiAi(id);
}

export function resetOAuthProviders(): void {
	resetOAuthProvidersFromPiAi();
}

export interface OAuthRefreshExecutionOptions {
	requestTimeoutMs?: number;
}

export async function refreshOAuthCredential(
	providerId: OAuthProviderId,
	credentials: OAuthCredentials,
	options: OAuthRefreshExecutionOptions = {},
): Promise<OAuthCredentials> {
	if (providerId === OPENAI_CODEX_PROVIDER_ID) {
		const requestTimeoutMs =
			typeof options.requestTimeoutMs === "number" &&
			Number.isFinite(options.requestTimeoutMs) &&
			options.requestTimeoutMs > 0
				? Math.floor(options.requestTimeoutMs)
				: DEFAULT_OAUTH_REFRESH_TIMEOUT_MS;
		return refreshOpenAICodexCredential(credentials, requestTimeoutMs);
	}

	const provider = getOAuthProviderFromPiAi(providerId);
	if (!provider) {
		throw new OAuthRefreshFailureError(
			`OAuth provider is not available for token refresh: ${providerId}`,
			{
				providerId,
				permanent: true,
				source: "extension",
				errorCode: UNSUPPORTED_OAUTH_REFRESH_PROVIDER_ERROR_CODE,
			},
		);
	}

	return provider.refreshToken(credentials);
}

export type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthProviderId,
	OAuthProviderInterface,
};
