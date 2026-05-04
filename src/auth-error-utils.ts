type OAuthRefreshFailureSource = "extension" | "provider";

const STRUCTURED_FIELD_SANITIZE_PATTERN = /[^a-z0-9._-]+/gi;

export interface OAuthRefreshFailureSummaryOptions {
	providerLabel?: string;
	status?: number;
	errorCode?: string;
	reason?: string;
	source?: OAuthRefreshFailureSource;
	permanent?: boolean;
}

export interface InferredOAuthRefreshFailureMetadata {
	errorCode?: string;
	reason?: string;
	permanent?: boolean;
}

export interface GetErrorMessageOptions {
	preserveStructuredData?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

export function getErrorMessage(
	error: unknown,
	options: GetErrorMessageOptions = {},
): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	if (options.preserveStructuredData) {
		try {
			const serialized = JSON.stringify(error);
			if (typeof serialized === "string") {
				return serialized;
			}
		} catch {
			// Fall back to String(error) when structured serialization is unavailable.
		}
	}
	return String(error);
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function createAbortError(message: string = "Operation aborted."): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

export function isAbortError(error: unknown): boolean {
	if (error instanceof Error) {
		return error.name === "AbortError" || /\babort(?:ed|ing|ion)?\b/i.test(error.message);
	}
	if (typeof error === "string") {
		return /\babort(?:ed|ing|ion)?\b/i.test(error);
	}
	return false;
}

export function toAbortError(signal: AbortSignal | undefined, fallbackMessage: string): Error {
	if (signal?.reason instanceof Error) {
		return signal.reason;
	}
	if (typeof signal?.reason === "string" && signal.reason.trim().length > 0) {
		return createAbortError(signal.reason);
	}
	return createAbortError(fallbackMessage);
}

export function throwIfAborted(signal: AbortSignal | undefined, fallbackMessage: string): void {
	if (signal?.aborted) {
		throw toAbortError(signal, fallbackMessage);
	}
}

export function throwFixedAbortErrorIfAborted(
	signal: AbortSignal | undefined,
	message: string,
): void {
	if (signal?.aborted) {
		throw createAbortError(message);
	}
}

export async function raceWithSignal<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	fallbackMessage: string,
): Promise<T> {
	throwIfAborted(signal, fallbackMessage);
	if (!signal) {
		return promise;
	}

	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(toAbortError(signal, fallbackMessage));
		};

		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export function normalizeStructuredAuthField(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const normalized = value.trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}

	const sanitized = normalized
		.replace(STRUCTURED_FIELD_SANITIZE_PATTERN, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return sanitized || undefined;
}

export function formatOAuthProviderLabel(providerId: string): string {
	const normalized = providerId.trim();
	if (!normalized) {
		return "OAuth";
	}
	if (normalized === "openai-codex") {
		return "OpenAI Codex";
	}
	return normalized;
}

export function formatOAuthRefreshFailureSummary(
	options: OAuthRefreshFailureSummaryOptions,
): string {
	const subject = options.providerLabel?.trim()
		? `${options.providerLabel.trim()} refresh`
		: "OAuth refresh";
	const action = options.permanent ? "rejected permanently" : "failed";
	const errorCode = normalizeStructuredAuthField(options.errorCode);
	const reason = errorCode ? undefined : normalizeStructuredAuthField(options.reason);
	const parts: string[] = [];

	if (typeof options.status === "number" && Number.isFinite(options.status)) {
		parts.push(`HTTP ${Math.trunc(options.status)}`);
	}
	if (errorCode) {
		parts.push(`code=${errorCode}`);
	}
	if (reason) {
		parts.push(`reason=${reason}`);
	}
	if (!errorCode && !reason && options.source === "provider") {
		parts.push("source=provider");
	}

	return parts.length > 0 ? `${subject} ${action} (${parts.join(", ")})` : `${subject} ${action}`;
}

export function inferOAuthRefreshFailureMetadata(
	rawMessage: string,
): InferredOAuthRefreshFailureMetadata {
	const normalized = rawMessage.trim();
	if (!normalized) {
		return { reason: "provider_error", permanent: false };
	}

	if (/already been used to generate a new access token/i.test(normalized)) {
		return {
			errorCode: "refresh_token_reused",
			reason: "token_reused",
			permanent: true,
		};
	}

	if (/refresh[_-]?token[_-]?reused/i.test(normalized)) {
		return {
			errorCode: "refresh_token_reused",
			reason: "token_reused",
			permanent: true,
		};
	}

	if (/invalid[_-]?grant/i.test(normalized)) {
		return {
			errorCode: "invalid_grant",
			reason: "token_rejected",
			permanent: true,
		};
	}

	if (/refresh token/i.test(normalized) && /(expired|revoked|invalid|not found)/i.test(normalized)) {
		return {
			reason: "token_rejected",
			permanent: true,
		};
	}

	if (/missing/i.test(normalized) && /refresh token/i.test(normalized)) {
		return {
			reason: "missing_refresh_token",
			permanent: true,
		};
	}

	if (/timed out|timeout|abort/i.test(normalized)) {
		return {
			errorCode: "request_timeout",
			reason: "request_timeout",
			permanent: false,
		};
	}

	return {
		reason: "provider_error",
		permanent: false,
	};
}
