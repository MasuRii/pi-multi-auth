import test from "node:test";
import assert from "node:assert/strict";
import {
	buildProviderPaneEntries,
	buildSmartApiKeyProviderOptions,
	buildSmartOAuthProviderOptions,
	CUSTOM_PROVIDER_NAME_OPTION,
	normalizeProviderSelectionInput,
	wrapAccountDisplayNameLines,
} from "../src/commands.js";
import {
	pruneBatchSelection,
	resolveBatchDeleteSelection,
	toggleBatchSelection,
} from "../src/account-batch-selection.js";
import type { CredentialStatus } from "../src/types.js";

function createCredentials(count: number): CredentialStatus[] {
	return Array.from({ length: count }, (_value, index) => ({
		credentialId: `credential-${index}`,
		credentialType: "api_key",
		redactedSecret: "sk-***",
		index,
		isActive: index === 0,
		expiresAt: null,
		isExpired: false,
		usageCount: 0,
		quotaErrorCount: 0,
	}));
}

test("smart OAuth provider options dedupe overlap and highlight selected/configured providers", () => {
	const options = buildSmartOAuthProviderOptions(
		[
			{ provider: "openai-codex", name: "ChatGPT Plus/Pro" },
			{ provider: "github-copilot", name: "GitHub Copilot" },
			{ provider: "anthropic", name: "Anthropic" },
			{ provider: "anthropic", name: "Anthropic Duplicate" },
		],
		[
			{ provider: "anthropic", credentials: createCredentials(2) },
			{ provider: "github-copilot", credentials: createCredentials(0) },
			{ provider: "openai-codex", credentials: createCredentials(1) },
			{ provider: "custom-api", credentials: createCredentials(1) },
		],
		"github-copilot",
	);

	assert.deepEqual(options.map((option) => option.provider), [
		"github-copilot",
		"anthropic",
		"openai-codex",
	]);
	assert.equal(options[0]?.isSelected, true);
	assert.equal(options[1]?.credentialCount, 2);
	assert.equal(options[2]?.credentialCount, 1);
});

test("smart API-key provider options keep selected provider first and retain custom entry", () => {
	const options = buildSmartApiKeyProviderOptions(
		[
			{ provider: "vivgrid", credentials: createCredentials(1) },
			{ provider: "openrouter", credentials: createCredentials(0) },
			{ provider: "anthropic", credentials: createCredentials(2) },
		],
		"openrouter",
	);

	assert.deepEqual(options.map((option) => option.provider), [
		"openrouter",
		"anthropic",
		"vivgrid",
		CUSTOM_PROVIDER_NAME_OPTION,
	]);
	assert.equal(options[0]?.isSelected, true);
	assert.equal(options[1]?.credentialCount, 2);
	assert.equal(options.at(-1)?.name, "Use custom provider name…");
});

test("smart API-key provider options include unconfigured supported providers and dedupe statuses", () => {
	const options = buildSmartApiKeyProviderOptions(
		[
			{ provider: "vivgrid", credentials: createCredentials(1) },
			{ provider: "custom-model-provider", credentials: createCredentials(0) },
		],
		"openrouter",
		[
			{ provider: "anthropic", name: "Anthropic" },
			{ provider: "openrouter", name: "OpenRouter" },
			{ provider: "vivgrid", name: "Vivgrid" },
		],
	);

	assert.deepEqual(options.map((option) => option.provider), [
		"openrouter",
		"vivgrid",
		"anthropic",
		"custom-model-provider",
		CUSTOM_PROVIDER_NAME_OPTION,
	]);
	assert.equal(options[0]?.credentialCount, 0);
	assert.equal(options[1]?.credentialCount, 1);
	assert.equal(options[1]?.isConfigured, true);
	assert.equal(options[0]?.name, "OpenRouter");
	assert.equal(options[0]?.isSelected, true);
	assert.equal(options[2]?.name, "Anthropic");
	assert.equal(options.at(-1)?.name, "Use custom provider name…");
});

test("provider input normalization canonicalizes known providers and rejects invalid names", () => {
	assert.deepEqual(
		normalizeProviderSelectionInput(" GitHub-Copilot ", ["github-copilot", "anthropic"]),
		{ ok: true, value: "github-copilot" },
	);
	assert.deepEqual(normalizeProviderSelectionInput("openrouter", ["github-copilot"]), {
		ok: true,
		value: "openrouter",
	});
	assert.deepEqual(normalizeProviderSelectionInput("   ", ["github-copilot"]), {
		ok: false,
		message: "Provider name is required.",
	});
	assert.deepEqual(normalizeProviderSelectionInput("bad provider", ["github-copilot"]), {
		ok: false,
		message: "Provider name cannot contain spaces. Use IDs like 'openrouter' or 'my-provider'.",
	});
});

test("provider pane entries always keep add provider at the bottom", () => {
	assert.deepEqual(
		buildProviderPaneEntries([
			{ provider: "github-copilot" },
			{ provider: "anthropic" },
		]),
		[
			{ kind: "provider", provider: "github-copilot", entryIndex: 0 },
			{ kind: "provider", provider: "anthropic", entryIndex: 1 },
			{ kind: "add", entryIndex: 2 },
		],
	);
	assert.deepEqual(buildProviderPaneEntries([]), [{ kind: "add", entryIndex: 0 }]);
});

test("account display names wrap instead of truncating", () => {
	const lines = wrapAccountDisplayNameLines("verylongusername@example.com", 10);
	assert.ok(lines.length > 1, "expected account label to wrap across multiple rows");
	assert.equal(lines.join(""), "verylongusername@example.com");
	assert.ok(lines.every((line) => line.length <= 10));
	assert.ok(lines.every((line) => !line.includes("…")));
});

test("batch selection toggles account marks and preserves insertion order", () => {
	const firstToggle = toggleBatchSelection(undefined, "credential-1");
	assert.deepEqual([...firstToggle], ["credential-1"]);

	const secondToggle = toggleBatchSelection(firstToggle, "credential-2");
	assert.deepEqual([...secondToggle], ["credential-1", "credential-2"]);

	const thirdToggle = toggleBatchSelection(secondToggle, "credential-1");
	assert.deepEqual([...thirdToggle], ["credential-2"]);
});

test("batch selection prunes credentials that are no longer visible", () => {
	const selection = new Set(["credential-1", "credential-2", "credential-3"]);
	assert.deepEqual(
		[...pruneBatchSelection(selection, ["credential-2", "credential-4"])],
		["credential-2"],
	);
});

test("batch delete resolution prefers marked accounts and falls back to the focused account", () => {
	assert.deepEqual(
		resolveBatchDeleteSelection(new Set(["credential-2", "credential-3"]), { kind: "add" }),
		{
			credentialIds: ["credential-2", "credential-3"],
			usesBatchSelection: true,
		},
	);
	assert.deepEqual(
		resolveBatchDeleteSelection(undefined, { kind: "account", credentialId: "credential-1" }),
		{
			credentialIds: ["credential-1"],
			usesBatchSelection: false,
		},
	);
	assert.deepEqual(resolveBatchDeleteSelection(undefined, { kind: "add" }), {
		credentialIds: [],
		usesBatchSelection: false,
	});
});
