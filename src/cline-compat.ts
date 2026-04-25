import { randomBytes } from "node:crypto";

export const CLINE_REFRESH_LEAD_TIME_MS = 5 * 60_000;

const CLINE_CLIENT_VERSION = "3.80.0";
const VSCODE_PLATFORM_VERSION = "1.109.3";
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface ClineClientHeaderOptions {
	includeJsonContentType?: boolean;
	includeRequestTracking?: boolean;
}

function encodeTimestampBase32(timestampMs: number): string {
	let value = Math.max(0, Math.floor(timestampMs));
	let encoded = "";
	for (let index = 0; index < 10; index += 1) {
		encoded = ULID_ALPHABET[value % 32] + encoded;
		value = Math.floor(value / 32);
	}
	return encoded;
}

function createClineTaskId(timestampMs: number = Date.now()): string {
	const entropy = randomBytes(16);
	let suffix = "";
	for (const byte of entropy) {
		suffix += ULID_ALPHABET[byte % 32];
	}
	return `${encodeTimestampBase32(timestampMs)}${suffix}`;
}

export function buildClineClientHeaders(
	options: ClineClientHeaderOptions = {},
): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": `Cline/${CLINE_CLIENT_VERSION}`,
		"X-PLATFORM": "Visual Studio Code",
		"X-PLATFORM-VERSION": VSCODE_PLATFORM_VERSION,
		"X-CLIENT-TYPE": "VSCode Extension",
		"X-CLIENT-VERSION": CLINE_CLIENT_VERSION,
		"X-CORE-VERSION": CLINE_CLIENT_VERSION,
	};

	if (options.includeJsonContentType) {
		headers["Content-Type"] = "application/json";
	}

	if (options.includeRequestTracking) {
		headers["HTTP-Referer"] = "https://cline.bot";
		headers["X-Title"] = "Cline";
		headers["X-TASK-ID"] = createClineTaskId();
		headers["X-IS-MULTIROOT"] = "false";
	}

	return headers;
}
