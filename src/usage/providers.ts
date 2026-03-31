import { anthropicUsageProvider } from "./anthropic.js";
import { codexUsageProvider } from "./codex.js";
import { copilotUsageProvider } from "./copilot.js";
import { antigravityUsageProvider } from "./google-antigravity.js";
import { geminiCliUsageProvider } from "./google-gemini-cli.js";
import type { UsageAuth, UsageProvider } from "./types.js";

export const usageProviders: ReadonlyArray<UsageProvider<UsageAuth>> = [
	codexUsageProvider,
	copilotUsageProvider,
	anthropicUsageProvider,
	geminiCliUsageProvider,
	antigravityUsageProvider,
];
