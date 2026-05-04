import { getErrorMessage, isRecord, normalizeNonEmptyString } from "./auth-error-utils.js";
import { isValidCloudflareOpenAIBaseUrl } from "./credential-request-overrides.js";
import type { StoredAuthCredential } from "./types.js";

const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_IDENTITY_LOOKUP_TIMEOUT_MS = 2_500;
const CLOUDFLARE_ACCOUNT_ID_FROM_BASE_URL_PATTERN =
	/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([^/]+)\/ai\/v1\/?$/;
const EMAIL_ADDRESS_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

interface CloudflareApiError {
	code?: number;
	message?: string;
}

interface CloudflareApiEnvelope {
	success?: boolean;
	result?: unknown;
	errors?: CloudflareApiError[];
}

interface CloudflareIdentityProbeResult {
	result: Record<string, unknown> | null;
	errorMessage: string | null;
}

export interface CloudflareCredentialIdentityLookupOptions {
	baseUrl?: string;
	signal?: AbortSignal;
}

export interface CloudflareCredentialIdentity {
	email: string | null;
	userId: string | null;
	accountId: string | null;
	accountName: string | null;
	tokenId: string | null;
	tokenStatus: string | null;
	displayName: string | null;
}

function extractCloudflareAccountIdFromBaseUrl(baseUrl: string | undefined): string | null {
	if (!baseUrl || !isValidCloudflareOpenAIBaseUrl(baseUrl)) {
		return null;
	}

	const match = CLOUDFLARE_ACCOUNT_ID_FROM_BASE_URL_PATTERN.exec(baseUrl.trim());
	return normalizeNonEmptyString(match?.[1]) ?? null;
}

export function extractCloudflareCredentialAccountId(
	credential: StoredAuthCredential,
): string | null {
	return extractCloudflareAccountIdFromBaseUrl(credential.request?.baseUrl);
}

function formatCloudflareApiErrors(errors: CloudflareApiError[] | undefined): string | null {
	if (!errors || errors.length === 0) {
		return null;
	}
	return errors
		.map((error) => {
			const code = typeof error.code === "number" ? `${error.code}: ` : "";
			return `${code}${error.message ?? "Unknown Cloudflare error"}`;
		})
		.join("; ");
}

function parseCloudflareApiEnvelope(value: unknown): CloudflareApiEnvelope {
	if (!isRecord(value)) {
		return { success: false, errors: [{ message: "Cloudflare response was not a JSON object." }] };
	}

	const errors = Array.isArray(value.errors)
		? value.errors.filter(isRecord).map((error) => ({
				code: typeof error.code === "number" ? error.code : undefined,
				message: typeof error.message === "string" ? error.message : undefined,
			}))
		: undefined;

	return {
		success: typeof value.success === "boolean" ? value.success : undefined,
		result: value.result,
		errors,
	};
}

async function fetchCloudflareIdentityProbe(
	apiToken: string,
	path: string,
	options: { signal?: AbortSignal } = {},
): Promise<CloudflareIdentityProbeResult> {
	if (options.signal?.aborted) {
		return { result: null, errorMessage: "Cloudflare identity lookup aborted." };
	}

	const abortController = new AbortController();
	const timeout = setTimeout(
		() => abortController.abort(),
		CLOUDFLARE_IDENTITY_LOOKUP_TIMEOUT_MS,
	);
	const abortFromParent = (): void => abortController.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", abortFromParent, { once: true });

	try {
		const response = await fetch(`${CLOUDFLARE_API_BASE_URL}${path}`, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiToken}`,
			},
			signal: abortController.signal,
		});

		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch (error: unknown) {
			return {
				result: null,
				errorMessage: `Cloudflare ${path} response was not valid JSON: ${getErrorMessage(error)}`,
			};
		}

		const envelope = parseCloudflareApiEnvelope(parsed);
		if (!response.ok || envelope.success !== true) {
			return {
				result: null,
				errorMessage:
					formatCloudflareApiErrors(envelope.errors) ??
					`Cloudflare ${path} lookup failed with HTTP ${response.status}.`,
			};
		}

		return {
			result: isRecord(envelope.result) ? envelope.result : null,
			errorMessage: null,
		};
	} catch (error: unknown) {
		return {
			result: null,
			errorMessage: getErrorMessage(error),
		};
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortFromParent);
	}
}

function firstNonEmptyString(...values: unknown[]): string | null {
	for (const value of values) {
		const normalized = normalizeNonEmptyString(value);
		if (normalized) {
			return normalized;
		}
	}
	return null;
}

function extractEmailAddress(value: unknown): string | null {
	const normalized = normalizeNonEmptyString(value);
	if (!normalized) {
		return null;
	}

	return EMAIL_ADDRESS_PATTERN.exec(normalized)?.[0] ?? null;
}

function firstEmailLikeString(...values: unknown[]): string | null {
	for (const value of values) {
		const email = extractEmailAddress(value);
		if (email) {
			return email;
		}
	}
	return null;
}

function resolveDisplayName(identity: Omit<CloudflareCredentialIdentity, "displayName">): string | null {
	return identity.email;
}

export async function fetchCloudflareCredentialIdentity(
	apiToken: string,
	options: CloudflareCredentialIdentityLookupOptions = {},
): Promise<CloudflareCredentialIdentity | null> {
	const normalizedToken = apiToken.trim();
	if (!normalizedToken) {
		return null;
	}

	const accountId = extractCloudflareAccountIdFromBaseUrl(options.baseUrl);
	const userPromise = fetchCloudflareIdentityProbe(normalizedToken, "/user", options);
	const billingPromise = fetchCloudflareIdentityProbe(
		normalizedToken,
		"/user/billing/profile",
		options,
	);
	const accountPromise = accountId
		? fetchCloudflareIdentityProbe(normalizedToken, `/accounts/${accountId}`, options)
		: Promise.resolve<CloudflareIdentityProbeResult>({ result: null, errorMessage: null });

	const [user, billing, account] = await Promise.all([
		userPromise,
		billingPromise,
		accountPromise,
	]);

	const email = firstEmailLikeString(
		user.result?.email,
		user.result?.primary_email,
		billing.result?.primary_email,
		billing.result?.enterprise_primary_email,
		billing.result?.payment_email,
		billing.result?.enterprise_billing_email,
		account.result?.name,
	);
	const userId = firstNonEmptyString(user.result?.id);
	const accountName = firstNonEmptyString(account.result?.name);
	const identity = {
		email,
		userId,
		accountId,
		accountName,
		tokenId: null,
		tokenStatus: null,
	};
	const displayName = resolveDisplayName(identity);

	if (!displayName) {
		return null;
	}

	return {
		...identity,
		displayName,
	};
}
