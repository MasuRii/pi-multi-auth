import { anthropicUsageProvider } from "./anthropic.js";
import { codexUsageProvider } from "./codex.js";
import { copilotUsageProvider } from "./copilot.js";
import type { UsageAuth, UsageProvider } from "./types.js";

export const usageProviders: ReadonlyArray<UsageProvider<UsageAuth>> = [
	codexUsageProvider,
	copilotUsageProvider,
	anthropicUsageProvider,
];
