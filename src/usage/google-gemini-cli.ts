import { quotaClassifier } from "../quota-classifier.js";
import { headersToRecord, rateLimitHeaderParser } from "../rate-limit-headers.js";
import type { RateLimitWindow, UsageAuth, UsageProvider, UsageSnapshot } from "./types.js";

const GOOGLE_ENDPOINT = "https://cloudcode-pa.googleapis.com";

const GEMINI_HEADERS: Record<string, string> = {
	"User-Agent": "google-api-nodejs-client/9.15.1",
	"X-Goog-Api-Client": "gl-node/22.17.0",
	"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
};

interface GeminiQuotaBucket {
	remainingFraction?: number;
	resetTime?: string;
}

interface ParsedQuotaWindow {
	usedPercent: number;
	resetsAt: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number | null {
	if (typeof value !== "string" || value.trim().length === 0) {
		return null;
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function parseQuotaWindows(value: unknown): ParsedQuotaWindow[] {
	if (!isRecord(value) || !Array.isArray(value.buckets)) {
		return [];
	}

	const windows: ParsedQuotaWindow[] = [];
	for (const bucket of value.buckets) {
		if (!isRecord(bucket)) {
			continue;
		}

		const remainingFraction = bucket.remainingFraction;
		if (typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) {
			continue;
		}

		const clampedRemaining = Math.max(0, Math.min(1, remainingFraction));
		windows.push({
			usedPercent: Math.round((1 - clampedRemaining) * 100),
			resetsAt: parseTimestamp(bucket.resetTime),
		});
	}

	windows.sort((left, right) => right.usedPercent - left.usedPercent);
	return windows;
}

function normalizeProjectId(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

async function discoverProjectId(accessToken: string): Promise<string | null> {
	const envProjectId =
		normalizeProjectId(process.env.GOOGLE_CLOUD_PROJECT) ??
		normalizeProjectId(process.env.GCP_PROJECT) ??
		normalizeProjectId(process.env.GCLOUD_PROJECT);
	if (envProjectId) {
		return envProjectId;
	}

	const response = await fetch(`${GOOGLE_ENDPOINT}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			...GEMINI_HEADERS,
		},
		body: JSON.stringify({
			metadata: {
				ideType: "IDE_UNSPECIFIED",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
			},
		}),
	});

	if (!response.ok) {
		if (response.status === 401) {
			throw new Error("Gemini OAuth token expired or invalid");
		}
		return null;
	}

	const payload = (await response.json()) as unknown;
	if (!isRecord(payload)) {
		return null;
	}

	return normalizeProjectId(payload.cloudaicompanionProject);
}

async function fetchQuotaWindows(
	accessToken: string,
	projectId: string,
): Promise<{ windows: ParsedQuotaWindow[]; responseHeaders: Record<string, string> }> {
	const response = await fetch(`${GOOGLE_ENDPOINT}/v1internal:retrieveUserQuota`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			...GEMINI_HEADERS,
		},
		body: JSON.stringify({ project: projectId }),
	});

	if (!response.ok) {
		if (response.status === 401) {
			throw new Error("Gemini OAuth token expired or invalid");
		}
		throw new Error(`Gemini quota request failed with status ${response.status}`);
	}

	const payload = (await response.json()) as unknown;
	return {
		windows: parseQuotaWindows(payload),
		responseHeaders: headersToRecord(response.headers),
	};
}

function toRateLimitWindow(window: ParsedQuotaWindow | undefined): RateLimitWindow | null {
	if (!window) {
		return null;
	}
	return {
		usedPercent: window.usedPercent,
		windowMinutes: 24 * 60,
		resetsAt: window.resetsAt,
	};
}

/**
 * Fetches Gemini CLI usage via Google Cloud Code Assist quota endpoints.
 */
export const geminiCliUsageProvider: UsageProvider<UsageAuth> = {
	id: "google-gemini-cli",
	displayName: "Google Gemini CLI",
	fetchUsage: async (auth: UsageAuth): Promise<UsageSnapshot | null> => {
		if (!auth.accessToken) {
			return null;
		}

		const projectId = await discoverProjectId(auth.accessToken);
		if (!projectId) {
			throw new Error(
				"Google Cloud project is required for Gemini usage. Set GOOGLE_CLOUD_PROJECT or run Gemini CLI once.",
			);
		}

		const { windows, responseHeaders } = await fetchQuotaWindows(auth.accessToken, projectId);
		const primary = toRateLimitWindow(windows[0]);
		const secondary = toRateLimitWindow(windows[1]);
		const rateLimitHeaders = rateLimitHeaderParser.parseHeaders(
			responseHeaders,
			"google-gemini-cli",
		);
		const quotaClassification = quotaClassifier.classifyFromUsage(
			primary,
			secondary,
			rateLimitHeaders,
		).classification;
		const now = Date.now();

		return {
			timestamp: now,
			provider: "google-gemini-cli",
			planType: "Gemini Code Assist",
			primary,
			secondary,
			credits: null,
			copilotQuota: null,
			updatedAt: now,
			rateLimitHeaders,
			estimatedResetAt: rateLimitHeaderParser.getEstimatedResetAt(rateLimitHeaders) ?? undefined,
			quotaClassification,
		};
	},
};
