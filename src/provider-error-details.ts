import type { Api, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { getErrorMessage, isRecord } from "./auth-error-utils.js";

const STATUS_ONLY_ERROR_PATTERN = /\b([1-5]\d{2})\s+status code\s*(?:\(no body\))?/i;
const DIAGNOSTIC_HTTP_STATUSES = new Set([401, 402, 403, 429]);
const DIAGNOSTIC_TIMEOUT_MS = 8_000;
const MAX_PROVIDER_ERROR_BODY_CHARS = 1_200;
const MAX_PROVIDER_ERROR_FIELD_CHARS = 300;

export interface ProviderErrorMessageEnrichmentRequest {
	model: Model<Api>;
	apiKey: string;
	headers?: SimpleStreamOptions["headers"];
	signal?: AbortSignal;
}

interface ProviderErrorSummary {
	status: number;
	summary: string;
}

export interface EnrichedProviderResponseDetails {
	status?: number;
	code?: string;
	message?: string;
}

export function parseEnrichedProviderResponse(message: string): EnrichedProviderResponseDetails {
	const providerResponseMatch = /provider response:\s*HTTP\s+(\d+)(?:\s+code=([^\s]+))?(?:\s+message="([^"]+)")?/i.exec(message);
	const details: EnrichedProviderResponseDetails = {};
	if (providerResponseMatch?.[1]) {
		details.status = Number.parseInt(providerResponseMatch[1], 10);
	}
	if (providerResponseMatch?.[2]?.trim()) {
		details.code = providerResponseMatch[2].trim();
	}
	if (providerResponseMatch?.[3]?.trim()) {
		details.message = providerResponseMatch[3].trim();
	}
	return details;
}

export function formatEnrichedProviderResponseBrief(
	details: EnrichedProviderResponseDetails,
): string | null {
	const metadataParts: string[] = [];
	if (typeof details.status === "number") {
		metadataParts.push(`HTTP ${details.status}`);
	}
	if (details.code) {
		metadataParts.push(`code ${details.code}`);
	}

	if (details.message) {
		return metadataParts.length > 0
			? `${details.message} (${metadataParts.join(", ")})`
			: details.message;
	}
	if (metadataParts.length > 0) {
		return metadataParts.join(", ");
	}
	return null;
}

function extractStatusOnlyHttpStatus(message: string): number | null {
	const match = STATUS_ONLY_ERROR_PATTERN.exec(message);
	if (!match) {
		return null;
	}

	const parsed = Number.parseInt(match[1] ?? "", 10);
	return Number.isInteger(parsed) ? parsed : null;
}

function isEligibleForDiagnosticProbe(status: number): boolean {
	return DIAGNOSTIC_HTTP_STATUSES.has(status);
}

function buildOpenAICompletionsDiagnosticUrl(model: Model<Api>): string | null {
	if (model.api !== "openai-completions") {
		return null;
	}

	const baseUrl = model.baseUrl.trim();
	if (!baseUrl) {
		return null;
	}

	try {
		const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
		return new URL("chat/completions", normalizedBaseUrl).toString();
	} catch {
		return null;
	}
}

function buildDiagnosticPayload(model: Model<Api>): Record<string, unknown> {
	return {
		model: model.id,
		messages: [{ role: "user", content: "ping" }],
		max_tokens: 1,
		stream: false,
	};
}

function buildDiagnosticHeaders(
	model: Model<Api>,
	apiKey: string,
	headers: SimpleStreamOptions["headers"],
): Record<string, string> {
	return {
		Accept: "application/json",
		"Content-Type": "application/json",
		...(model.headers ?? {}),
		...(headers ?? {}),
		Authorization: `Bearer ${apiKey}`,
	};
}

function truncateField(value: string, maxChars: number = MAX_PROVIDER_ERROR_FIELD_CHARS): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}
	return `${normalized.slice(0, maxChars)}…`;
}

function stringifyJsonField(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

function extractJsonErrorFields(parsed: unknown): { code?: string; message?: string } {
	if (!isRecord(parsed)) {
		return {};
	}

	const nestedError = isRecord(parsed.error) ? parsed.error : undefined;
	const firstCloudflareError = Array.isArray(parsed.errors)
		? parsed.errors.find(isRecord)
		: undefined;
	const code =
		stringifyJsonField(parsed.code) ??
		stringifyJsonField(parsed.error_code) ??
		stringifyJsonField(nestedError?.code) ??
		stringifyJsonField(nestedError?.type) ??
		stringifyJsonField(firstCloudflareError?.code);
	const message =
		stringifyJsonField(parsed.message) ??
		stringifyJsonField(parsed.detail) ??
		stringifyJsonField(parsed.msg) ??
		stringifyJsonField(parsed.error) ??
		stringifyJsonField(nestedError?.message) ??
		stringifyJsonField(firstCloudflareError?.message);

	return { code, message };
}

function formatProviderErrorSummary(status: number, body: string): string | null {
	const normalizedBody = truncateField(body, MAX_PROVIDER_ERROR_BODY_CHARS);
	if (!normalizedBody) {
		return null;
	}

	try {
		const parsed = JSON.parse(normalizedBody) as unknown;
		const fields = extractJsonErrorFields(parsed);
		const parts = [`HTTP ${status}`];
		if (fields.code) {
			parts.push(`code=${truncateField(fields.code)}`);
		}
		if (fields.message) {
			parts.push(`message="${truncateField(fields.message)}"`);
		}
		if (parts.length > 1) {
			return parts.join(" ");
		}
	} catch {
		// Non-JSON provider bodies are summarized as text below.
	}

	return `HTTP ${status} body="${normalizedBody}"`;
}

async function readResponseBodyPreview(response: Response): Promise<string> {
	if (!response.body) {
		return "";
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let result = "";
	let shouldCancel = false;

	try {
		while (result.length <= MAX_PROVIDER_ERROR_BODY_CHARS) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			result += decoder.decode(value, { stream: true });
			if (result.length > MAX_PROVIDER_ERROR_BODY_CHARS) {
				shouldCancel = true;
				break;
			}
		}
		result += decoder.decode();
		if (shouldCancel) {
			await reader.cancel();
		}
	} finally {
		reader.releaseLock();
	}

	return shouldCancel ? `${result.slice(0, MAX_PROVIDER_ERROR_BODY_CHARS)}…` : result;
}

async function probeProviderErrorBody(
	request: ProviderErrorMessageEnrichmentRequest,
): Promise<ProviderErrorSummary | null> {
	if (request.signal?.aborted) {
		return null;
	}

	const url = buildOpenAICompletionsDiagnosticUrl(request.model);
	if (!url) {
		return null;
	}

	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort(), DIAGNOSTIC_TIMEOUT_MS);
	const abortFromParent = (): void => abortController.abort(request.signal?.reason);
	request.signal?.addEventListener("abort", abortFromParent, { once: true });

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: buildDiagnosticHeaders(request.model, request.apiKey, request.headers),
			body: JSON.stringify(buildDiagnosticPayload(request.model)),
			signal: abortController.signal,
		});

		if (response.ok) {
			await response.body?.cancel();
			return null;
		}

		const body = await readResponseBodyPreview(response);
		const summary = formatProviderErrorSummary(response.status, body);
		return summary ? { status: response.status, summary } : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
		request.signal?.removeEventListener("abort", abortFromParent);
	}
}

export async function enrichProviderStatusOnlyErrorMessage(
	message: string,
	request: ProviderErrorMessageEnrichmentRequest,
): Promise<string> {
	const status = extractStatusOnlyHttpStatus(message);
	if (status === null || !isEligibleForDiagnosticProbe(status)) {
		return message;
	}

	const providerSummary = await probeProviderErrorBody(request);
	if (!providerSummary) {
		return message;
	}

	if (providerSummary.status !== status) {
		return message;
	}

	const providerDetail = `provider response: ${providerSummary.summary}`;
	if (message.includes(providerDetail)) {
		return message;
	}

	return `${getErrorMessage(message)}; ${providerDetail}`;
}
