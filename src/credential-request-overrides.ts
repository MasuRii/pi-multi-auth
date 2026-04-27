import type { Api, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { StoredAuthCredential, SupportedProviderId } from "./types.js";

const CLOUDFLARE_OPENAI_BASE_URL_PATTERN =
	/^\/client\/v4\/accounts\/[^/]+\/ai\/v1\/?$/;

export class CredentialRequestConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CredentialRequestConfigurationError";
	}
}

interface RequestOverrideInput {
	provider: SupportedProviderId;
	credentialId: string;
	credential: StoredAuthCredential;
	model: Model<Api>;
	headers: SimpleStreamOptions["headers"];
}

interface RequestOverrideResult {
	model: Model<Api>;
	headers: SimpleStreamOptions["headers"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRequestOverrides(
	provider: SupportedProviderId,
	credentialId: string,
	credential: StoredAuthCredential,
): Record<string, unknown> | undefined {
	const request = credential.request;
	if (request === undefined) {
		return undefined;
	}
	if (!isRecord(request)) {
		throw new CredentialRequestConfigurationError(
			`Credential '${credentialId}' for ${provider} request must be an object.`,
		);
	}
	return request;
}

function validateBaseUrl(
	provider: SupportedProviderId,
	credentialId: string,
	baseUrl: string,
): string {
	const normalized = baseUrl.trim();
	if (!normalized) {
		throw new CredentialRequestConfigurationError(
			`Credential '${credentialId}' for ${provider} has an empty request.baseUrl.`,
		);
	}

	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new CredentialRequestConfigurationError(
			`Credential '${credentialId}' for ${provider} has an invalid request.baseUrl: ${normalized}`,
		);
	}

	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new CredentialRequestConfigurationError(
			`Credential '${credentialId}' for ${provider} request.baseUrl must use http or https.`,
		);
	}

	return normalized.replace(/\/$/, "");
}

function validateHeaders(
	provider: SupportedProviderId,
	credentialId: string,
	headers: unknown,
): Record<string, string> | undefined {
	if (headers === undefined) {
		return undefined;
	}
	if (!isRecord(headers)) {
		throw new CredentialRequestConfigurationError(
			`Credential '${credentialId}' for ${provider} request.headers must be an object of string values.`,
		);
	}

	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const headerName = key.trim();
		if (!headerName || typeof value !== "string") {
			throw new CredentialRequestConfigurationError(
				`Credential '${credentialId}' for ${provider} request.headers must contain non-empty string keys and string values.`,
			);
		}
		normalized[headerName] = value;
	}

	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function buildCloudflareWorkersAiBaseUrl(accountId: string): string {
	const normalized = accountId.trim();
	if (!normalized) {
		throw new CredentialRequestConfigurationError(
			"Cloudflare account ID cannot be empty.",
		);
	}
	return `https://api.cloudflare.com/client/v4/accounts/${normalized}/ai/v1`;
}

export function isValidCloudflareOpenAIBaseUrl(baseUrl: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return false;
	}

	return (
		parsed.protocol === "https:" &&
		parsed.hostname === "api.cloudflare.com" &&
		CLOUDFLARE_OPENAI_BASE_URL_PATTERN.test(parsed.pathname)
	);
}

function assertCloudflareBaseUrl(
	credentialId: string,
	baseUrl: string,
): void {
	if (isValidCloudflareOpenAIBaseUrl(baseUrl)) {
		return;
	}

	throw new CredentialRequestConfigurationError(
		`Cloudflare credential '${credentialId}' must define request.baseUrl as https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1 so multi-auth can rotate account-scoped Cloudflare credentials correctly.`,
	);
}

export function applyCredentialRequestOverrides({
	provider,
	credentialId,
	credential,
	model,
	headers,
}: RequestOverrideInput): RequestOverrideResult {
	const request = getRequestOverrides(provider, credentialId, credential);
	const configuredBaseUrl = request?.baseUrl;
	const credentialHeaders = validateHeaders(provider, credentialId, request?.headers);
	let effectiveModel = model;

	if (configuredBaseUrl !== undefined) {
		if (typeof configuredBaseUrl !== "string") {
			throw new CredentialRequestConfigurationError(
				`Credential '${credentialId}' for ${provider} request.baseUrl must be a string.`,
			);
		}
		effectiveModel = {
			...model,
			baseUrl: validateBaseUrl(provider, credentialId, configuredBaseUrl),
		};
	}

	if (provider === "cloudflare") {
		assertCloudflareBaseUrl(credentialId, effectiveModel.baseUrl);
	}

	return {
		model: effectiveModel,
		headers: credentialHeaders ? { ...headers, ...credentialHeaders } : headers,
	};
}
