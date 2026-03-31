import { createHash } from "node:crypto";
import type { StoredAuthCredential } from "./types.js";

function fingerprint(secret: string): string {
	return createHash("sha256").update(secret).digest("hex").slice(0, 10);
}

function redact(secret: string): string {
	const normalized = secret.trim();
	if (!normalized) {
		return "(empty)";
	}

	if (normalized.length <= 8) {
		return `${"•".repeat(Math.max(4, normalized.length))} (len ${normalized.length})`;
	}

	const head = normalized.slice(0, 3);
	const tail = normalized.slice(-4);
	return `${head}${"•".repeat(6)}${tail} (len ${normalized.length})`;
}

export function getCredentialSecret(credential: StoredAuthCredential): string {
	return credential.type === "oauth" ? credential.access : credential.key;
}

export function formatCredentialRedaction(credential: StoredAuthCredential): string {
	const secret = getCredentialSecret(credential);
	const secretPreview = redact(secret);
	return `${credential.type} • ${secretPreview} • fp:${fingerprint(secret)}`;
}

export function validateApiKeyInput(value: string): { ok: true; value: string } | { ok: false; message: string } {
	const normalized = value.trim();
	if (!normalized) {
		return {
			ok: false,
			message: "API key cannot be empty. Paste a non-empty key.",
		};
	}

	return {
		ok: true,
		value: normalized,
	};
}

interface ParseApiKeyBatchOptions {
	allowMultiple?: boolean;
}

const MIN_MARKER_LENGTH = 3;
const MAX_MARKER_SCAN_LENGTH = 48;
const MIN_CHUNK_SUFFIX_LENGTH = 4;

function findMarkerStartIndexes(value: string, marker: string): number[] {
	const starts: number[] = [];
	let cursor = 0;
	while (cursor <= value.length - marker.length) {
		const foundAt = value.indexOf(marker, cursor);
		if (foundAt < 0) {
			break;
		}
		starts.push(foundAt);
		cursor = foundAt + marker.length;
	}
	return starts;
}

function splitConcatenatedByMarker(value: string, marker: string): string[] | null {
	if (!value.startsWith(marker)) {
		return null;
	}

	const starts = findMarkerStartIndexes(value, marker);
	if (starts.length < 2 || starts[0] !== 0) {
		return null;
	}

	const chunks: string[] = [];
	for (let index = 0; index < starts.length; index += 1) {
		const start = starts[index];
		const end = starts[index + 1] ?? value.length;
		const chunk = value.slice(start, end).trim();
		if (!chunk || chunk === marker || chunk.length < marker.length + MIN_CHUNK_SUFFIX_LENGTH) {
			return null;
		}
		chunks.push(chunk);
	}

	return chunks;
}

function isLikelyMarker(marker: string): boolean {
	return marker.length >= MIN_MARKER_LENGTH && /[A-Za-z]/.test(marker) && /[-_]$/.test(marker);
}

function detectRepeatedApiKeyMarker(value: string): string | null {
	const scanLimit = Math.min(value.length, MAX_MARKER_SCAN_LENGTH);
	let bestMarker: string | null = null;
	let bestMatchCount = 0;

	for (let index = 0; index < scanLimit; index += 1) {
		const character = value[index];
		if (character !== "-" && character !== "_") {
			continue;
		}

		const marker = value.slice(0, index + 1);
		if (!isLikelyMarker(marker)) {
			continue;
		}

		const starts = findMarkerStartIndexes(value, marker);
		if (starts.length < 2 || starts[0] !== 0) {
			continue;
		}

		const hasInvalidChunk = starts.some((start, position) => {
			const end = starts[position + 1] ?? value.length;
			return end - start < marker.length + MIN_CHUNK_SUFFIX_LENGTH;
		});
		if (hasInvalidChunk) {
			continue;
		}

		if (
			bestMarker === null ||
			marker.length > bestMarker.length ||
			(marker.length === bestMarker.length && starts.length > bestMatchCount)
		) {
			bestMarker = marker;
			bestMatchCount = starts.length;
		}
	}

	return bestMarker;
}

function expandPotentiallyConcatenatedApiKeys(token: string): string[] {
	const normalized = token.trim();
	if (!normalized) {
		return [];
	}

	const marker = detectRepeatedApiKeyMarker(normalized);
	if (!marker) {
		return [normalized];
	}

	return splitConcatenatedByMarker(normalized, marker) ?? [normalized];
}

export function parseApiKeyBatchInput(
	value: string,
	options: ParseApiKeyBatchOptions = {},
):
	| {
			ok: true;
			keys: string[];
			duplicateCount: number;
			ignoredLineCount: number;
	  }
	| {
			ok: false;
			message: string;
	  } {
	const normalizedInput = value.replace(/\r\n/g, "\n");
	const lines = normalizedInput.split("\n");
	const allowMultiple = options.allowMultiple ?? true;
	const keys: string[] = [];
	const seen = new Set<string>();
	let duplicateCount = 0;
	let ignoredLineCount = 0;

	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("```")) {
			ignoredLineCount += 1;
			continue;
		}

		const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
		if (tokens.length === 0) {
			ignoredLineCount += 1;
			continue;
		}

		const parsedTokens = tokens.flatMap((token) =>
			allowMultiple ? expandPotentiallyConcatenatedApiKeys(token) : [token],
		);
		if (!allowMultiple && parsedTokens.length > 1) {
			return {
				ok: false,
				message: "Multiple API keys detected. Paste a single API key for this provider.",
			};
		}

		for (const token of parsedTokens) {
			const validation = validateApiKeyInput(token);
			if (!validation.ok) {
				const prefix = lines.length > 1 ? `Line ${index + 1}: ` : "";
				return {
					ok: false,
					message: `${prefix}${validation.message}`,
				};
			}

			if (seen.has(validation.value)) {
				duplicateCount += 1;
				continue;
			}

			if (!allowMultiple && keys.length > 0) {
				return {
					ok: false,
					message: "Multiple API keys detected. Paste a single API key for this provider.",
				};
			}

			seen.add(validation.value);
			keys.push(validation.value);
		}
	}

	if (keys.length === 0) {
		return {
			ok: false,
			message: "No API keys detected. Paste at least one non-empty API key.",
		};
	}

	return {
		ok: true,
		keys,
		duplicateCount,
		ignoredLineCount,
	};
}
