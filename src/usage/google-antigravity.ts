import { quotaClassifier } from "../quota-classifier.js";
import { headersToRecord, rateLimitHeaderParser } from "../rate-limit-headers.js";
import type { RateLimitWindow, UsageAuth, UsageProvider, UsageSnapshot } from "./types.js";

const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://autopush-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
] as const;

const ANTIGRAVITY_HEADERS = {
	"User-Agent": "antigravity/1.11.5 windows/amd64",
	"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"Client-Metadata":
		'{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
};

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

function parseWindows(payload: unknown): ParsedQuotaWindow[] {
	if (!isRecord(payload) || !isRecord(payload.models)) {
		return [];
	}

	const windows: ParsedQuotaWindow[] = [];
	for (const modelData of Object.values(payload.models)) {
		if (!isRecord(modelData) || !isRecord(modelData.quotaInfo)) {
			continue;
		}

		const remainingFraction = modelData.quotaInfo.remainingFraction;
		if (typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) {
			continue;
		}

		const clampedRemaining = Math.max(0, Math.min(1, remainingFraction));
		windows.push({
			usedPercent: Math.round((1 - clampedRemaining) * 100),
			resetsAt: parseTimestamp(modelData.quotaInfo.resetTime),
		});
	}

	windows.sort((left, right) => right.usedPercent - left.usedPercent);
	return windows;
}

async function fetchAntigravityWindows(
	accessToken: string,
): Promise<{ windows: ParsedQuotaWindow[]; responseHeaders: Record<string, string> }> {
	let lastErrorMessage = "Unknown error";

	for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
		const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				...ANTIGRAVITY_HEADERS,
			},
			body: "{}",
		});

		if (!response.ok) {
			if (response.status === 401) {
				throw new Error("Antigravity OAuth token expired or invalid");
			}
			lastErrorMessage = `endpoint ${endpoint} failed with status ${response.status}`;
			continue;
		}

		const payload = (await response.json()) as unknown;
		const windows = parseWindows(payload);
		if (windows.length > 0) {
			return {
				windows,
				responseHeaders: headersToRecord(response.headers),
			};
		}
		lastErrorMessage = `endpoint ${endpoint} returned no quota windows`;
	}

	throw new Error(`Unable to fetch Antigravity usage (${lastErrorMessage})`);
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
 * Fetches Antigravity quota usage from Google Cloud internal model endpoints.
 */
export const antigravityUsageProvider: UsageProvider<UsageAuth> = {
	id: "google-antigravity",
	displayName: "Google Antigravity",
	fetchUsage: async (auth: UsageAuth): Promise<UsageSnapshot | null> => {
		if (!auth.accessToken) {
			return null;
		}

		const { windows, responseHeaders } = await fetchAntigravityWindows(auth.accessToken);
		const rateLimitHeaders = rateLimitHeaderParser.parseHeaders(
			responseHeaders,
			"google-antigravity",
		);
		const primary = toRateLimitWindow(windows[0]);
		const secondary = toRateLimitWindow(windows[1]);
		const quotaClassification = quotaClassifier.classifyFromUsage(
			primary,
			secondary,
			rateLimitHeaders,
		).classification;
		const now = Date.now();
		return {
			timestamp: now,
			provider: "google-antigravity",
			planType: "Gemini Advanced",
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
