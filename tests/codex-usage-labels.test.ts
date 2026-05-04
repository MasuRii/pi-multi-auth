import assert from "node:assert/strict";
import test from "node:test";

import { resolveUsageWindowLabel } from "../src/commands.js";
import type { UsageSnapshot } from "../src/usage/types.js";

function createSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	const now = Date.now();
	return {
		timestamp: now,
		provider: "openai-codex",
		planType: "ChatGPT Plus",
		primary: { usedPercent: 10, windowMinutes: 300, resetsAt: Math.ceil((now + 300 * 60_000) / 1000) },
		secondary: { usedPercent: 20, windowMinutes: 10_080, resetsAt: Math.ceil((now + 10_080 * 60_000) / 1000) },
		credits: null,
		copilotQuota: null,
		updatedAt: now,
		...overrides,
	};
}

test("usage window labels derive from quota metadata instead of provider hardcodes", () => {
	const snapshot = createSnapshot();

	assert.equal(resolveUsageWindowLabel(snapshot, "primary"), "5-hour window");
	assert.equal(resolveUsageWindowLabel(snapshot, "secondary"), "7-day window");
});

test("usage window labels disambiguate matching duration windows generically", () => {
	const snapshot = createSnapshot({
		provider: "anthropic",
		secondary: { usedPercent: 20, windowMinutes: 300, resetsAt: null },
	});

	assert.equal(resolveUsageWindowLabel(snapshot, "primary"), "5-hour window (window 1)");
	assert.equal(resolveUsageWindowLabel(snapshot, "secondary"), "5-hour window (window 2)");
});
