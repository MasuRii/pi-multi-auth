import { parseApiKeyBatchInput } from "./credential-display.js";
import {
	buildCloudflareWorkersAiBaseUrl,
	isValidCloudflareOpenAIBaseUrl,
} from "./credential-request-overrides.js";
import type { CredentialRequestOverrides } from "./types.js";

const CLOUDFLARE_API_TOKEN_PATTERN = /(?<![A-Za-z0-9_-])cfat_[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;
const CLOUDFLARE_WORKERS_AI_BASE_URL_PATTERN =
	/https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1\/?/gi;
const CLOUDFLARE_ACCOUNT_ID_PATTERNS: readonly RegExp[] = [
	/dash\.cloudflare\.com\/([a-f0-9]{32})(?:\/|$|[?#])/gi,
	/(?:\/api\/v4|\/client\/v4)\/accounts\/([a-f0-9]{32})(?:\/|$|[?#])/gi,
	/com\.cloudflare\.api\.account\.([a-f0-9]{32})(?:\b|["'{}\],])/gi,
	/\baccount(?:[_-]?id)?\s*[:=]\s*["']?([a-f0-9]{32})(?:\b|["'])/gi,
];

export interface ParsedCloudflareCredentialInputEntry {
	apiToken: string;
	request?: CredentialRequestOverrides;
}

export type ParsedCloudflareCredentialInput =
	| {
			ok: true;
			entries: ParsedCloudflareCredentialInputEntry[];
			duplicateCount: number;
			ignoredLineCount: number;
			requestOverrideCount: number;
	  }
	| {
			ok: false;
			message: string;
	  };

function uniqueStrings(values: Iterable<string>): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const value of values) {
		const normalized = value.trim();
		if (!normalized || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		unique.push(normalized);
	}
	return unique;
}

function normalizeCloudflareScanText(value: string): string {
	return value.replace(/\\\//g, "/");
}

function extractCloudflareApiTokens(value: string): string[] {
	return uniqueStrings(
		[...normalizeCloudflareScanText(value).matchAll(CLOUDFLARE_API_TOKEN_PATTERN)].map(
			(match) => match[0],
		),
	);
}

function extractCloudflareWorkersAiBaseUrls(value: string): string[] {
	return uniqueStrings(
		[...normalizeCloudflareScanText(value).matchAll(CLOUDFLARE_WORKERS_AI_BASE_URL_PATTERN)]
			.map((match) => match[0])
			.filter(isValidCloudflareOpenAIBaseUrl)
			.map((baseUrl) => baseUrl.replace(/\/$/, "")),
	);
}

function extractCloudflareAccountIds(value: string): string[] {
	const normalized = normalizeCloudflareScanText(value);
	const accountIds: string[] = [];
	for (const pattern of CLOUDFLARE_ACCOUNT_ID_PATTERNS) {
		for (const match of normalized.matchAll(pattern)) {
			const accountId = match[1]?.trim().toLowerCase();
			if (accountId) {
				accountIds.push(accountId);
			}
		}
	}
	return uniqueStrings(accountIds);
}

function resolveCloudflareRequestOverridesFromText(
	value: string,
): CredentialRequestOverrides | undefined {
	const baseUrls = extractCloudflareWorkersAiBaseUrls(value);
	if (baseUrls.length === 1) {
		return { baseUrl: baseUrls[0] };
	}

	const accountIds = extractCloudflareAccountIds(value);
	if (accountIds.length === 1) {
		return { baseUrl: buildCloudflareWorkersAiBaseUrl(accountIds[0]) };
	}

	return undefined;
}

function dedupeCloudflareEntries(
	entries: ParsedCloudflareCredentialInputEntry[],
): { entries: ParsedCloudflareCredentialInputEntry[]; duplicateCount: number } {
	const deduped: ParsedCloudflareCredentialInputEntry[] = [];
	const indexByToken = new Map<string, number>();
	let duplicateCount = 0;

	for (const entry of entries) {
		const existingIndex = indexByToken.get(entry.apiToken);
		if (existingIndex === undefined) {
			indexByToken.set(entry.apiToken, deduped.length);
			deduped.push(entry);
			continue;
		}

		duplicateCount += 1;
		const existing = deduped[existingIndex];
		if (existing && !existing.request && entry.request) {
			deduped[existingIndex] = {
				...existing,
				request: entry.request,
			};
		}
	}

	return { entries: deduped, duplicateCount };
}

function parseGenericApiKeyFallback(
	value: string,
	allowMultiple: boolean,
): ParsedCloudflareCredentialInput {
	const parsed = parseApiKeyBatchInput(value, { allowMultiple });
	if (!parsed.ok) {
		return parsed;
	}

	return {
		ok: true,
		entries: parsed.keys.map((apiToken) => ({ apiToken })),
		duplicateCount: parsed.duplicateCount,
		ignoredLineCount: parsed.ignoredLineCount,
		requestOverrideCount: 0,
	};
}

export function parseCloudflareCredentialBatchInput(
	value: string,
	options: { allowMultiple?: boolean } = {},
): ParsedCloudflareCredentialInput {
	const allowMultiple = options.allowMultiple ?? true;
	const normalizedInput = value.replace(/\r\n/g, "\n");
	const lines = normalizedInput.split("\n");
	const entries: ParsedCloudflareCredentialInputEntry[] = [];
	let ignoredLineCount = 0;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("```")) {
			ignoredLineCount += 1;
			continue;
		}

		const apiTokens = extractCloudflareApiTokens(trimmed);
		if (apiTokens.length === 0) {
			continue;
		}
		if (!allowMultiple && (entries.length > 0 || apiTokens.length > 1)) {
			return {
				ok: false,
				message: "Multiple Cloudflare API tokens detected. Paste a single token for this provider.",
			};
		}

		const request = resolveCloudflareRequestOverridesFromText(trimmed);
		for (const apiToken of apiTokens) {
			entries.push({
				apiToken,
				...(request && { request }),
			});
		}
	}

	if (entries.length === 0) {
		return parseGenericApiKeyFallback(normalizedInput, allowMultiple);
	}

	const sharedRequest = resolveCloudflareRequestOverridesFromText(normalizedInput);
	const entriesWithSharedRequest = entries.map((entry) => ({
		...entry,
		...(!entry.request && sharedRequest ? { request: sharedRequest } : {}),
	}));
	const deduped = dedupeCloudflareEntries(entriesWithSharedRequest);
	const requestOverrideCount = deduped.entries.filter((entry) => entry.request?.baseUrl).length;

	return {
		ok: true,
		entries: deduped.entries,
		duplicateCount: deduped.duplicateCount,
		ignoredLineCount,
		requestOverrideCount,
	};
}
