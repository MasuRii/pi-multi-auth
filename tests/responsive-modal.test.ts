import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
	renderWrappedFooterActions,
	resolveBodyRowBudget,
	resolveTerminalRows,
	wrapTextToWidth,
} from "../src/formatters/responsive-modal.js";
import { renderZellijFrame } from "../src/formatters/zellij-frame.js";
import {
	formatProviderBadge,
	truncateAccountIdentifier,
} from "../src/formatters/multi-auth-display.js";
import {
	formatHiddenProviderHint,
	resolveFooterActions,
	summarizeProviderVisibility,
} from "../src/formatters/modal-ui.js";
import { formatRotationModeLabel } from "../src/rotation-modes.js";

const PROVIDER_FOOTER_ACTIONS = resolveFooterActions({
	focusedPane: "providers",
	renameMode: false,
	hasProviderSelection: true,
	hasProviderCredentials: true,
	selectedEntryKind: "account",
	selectedProviderPaneEntryKind: "provider",
	selectedProviderHidden: false,
	hasHiddenProviders: true,
	showHiddenProviders: false,
	hasDisabledAccounts: true,
	showDisabledAccounts: false,
	hasBatchSelection: false,
	selectedAccountMarked: false,
});

test("wrapped footer actions keep provider keybinds visible on narrow widths", () => {
	const lines = renderWrappedFooterActions(PROVIDER_FOOTER_ACTIONS, 20);
	const rendered = lines.join("\n");

	assert.ok(lines.length > 2, "expected multiline footer rendering for width=20");
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 20, `line exceeded width budget: ${line}`);
	}

	for (const keybind of ["[Enter]", "[m]", "[v]", "[Esc]"]) {
		assert.match(rendered, new RegExp(keybind.replace(/[\[\]]/g, "\\$&")));
	}
	assert.doesNotMatch(rendered, /\[r\]/, "provider footer should not include rename");
});

test("account footer actions only show account-scoped actions", () => {
	const actions = resolveFooterActions({
		focusedPane: "accounts",
		renameMode: false,
		hasProviderSelection: true,
		hasProviderCredentials: true,
		selectedEntryKind: "account",
		selectedProviderHidden: false,
		hasHiddenProviders: true,
		showHiddenProviders: false,
		hasDisabledAccounts: false,
		showDisabledAccounts: false,
		hasBatchSelection: false,
		selectedAccountMarked: false,
	});

	assert.deepEqual(actions, [
		"[Enter] Set/Clear Manual Active",
		"[Space] Mark",
		"[r] Rename",
		"[T] Refresh Selected",
		"[d] Delete",
		"[t] Refresh Provider",
		"[v] Show Hidden/Empty",
		"[←/→] Pane",
		"[Esc] Close",
	]);
});

test("account add row footer avoids duplicate add shortcut", () => {
	const actions = resolveFooterActions({
		focusedPane: "accounts",
		renameMode: false,
		hasProviderSelection: true,
		hasProviderCredentials: true,
		selectedEntryKind: "add",
		selectedProviderHidden: false,
		hasHiddenProviders: false,
		showHiddenProviders: false,
		hasDisabledAccounts: false,
		showDisabledAccounts: false,
		hasBatchSelection: false,
		selectedAccountMarked: false,
	});

	assert.deepEqual(actions, ["[Enter] Add", "[t] Refresh Provider", "[←/→] Pane", "[Esc] Close"]);
});

test("rename mode footer collapses to save and cancel", () => {
	const actions = resolveFooterActions({
		focusedPane: "accounts",
		renameMode: true,
		hasProviderSelection: true,
		hasProviderCredentials: true,
		selectedEntryKind: "account",
		selectedProviderHidden: false,
		hasHiddenProviders: true,
		showHiddenProviders: false,
		hasDisabledAccounts: true,
		showDisabledAccounts: false,
		hasBatchSelection: false,
		selectedAccountMarked: false,
	});

	assert.deepEqual(actions, ["[Enter] Save", "[Esc] Cancel Rename"]);
});

test("body row budget shrinks when terminal rows are constrained", () => {
	const bodyRows = resolveBodyRowBudget({
		defaultRows: 22,
		terminalRows: 14,
		reservedRows: 9,
		minimumRows: 4,
	});

	assert.equal(bodyRows, 5);
});

test("terminal row resolver falls back to LINES env when stdout rows are unavailable", () => {
	const originalLines = process.env.LINES;
	process.env.LINES = "17";
	try {
		const rows = resolveTerminalRows();
		assert.equal(rows, 17);
	} finally {
		if (originalLines === undefined) {
			delete process.env.LINES;
		} else {
			process.env.LINES = originalLines;
		}
	}
});

test("zellij frame no longer forces large minimum width", () => {
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};

	const rendered = renderZellijFrame(["hello"], 8, theme, {
		titleLeft: "",
		minWidth: 42,
		focused: true,
	});

	assert.equal(rendered.contentWidth, 6);
	for (const line of rendered.lines) {
		assert.equal(visibleWidth(line), 8);
	}
});

test("zellij frame renders a top-left title without breaking width", () => {
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};

	const rendered = renderZellijFrame(["hello"], 20, theme, {
		titleLeft: "Pi Multi Auth",
		focused: true,
	});

	assert.match(rendered.lines[0] ?? "", /Pi Multi Auth/);
	for (const line of rendered.lines) {
		assert.equal(visibleWidth(line), 20);
	}
});

test("word wrapping handles extremely small widths", () => {
	const wrapped = wrapTextToWidth("[Enter] Set/Clear Manual Active", 3);
	assert.ok(wrapped.length > 3);
	for (const line of wrapped) {
		assert.ok(visibleWidth(line) <= 3);
	}
});

test("account identifiers keep email domains visible with middle ellipsis", () => {
	const shortened = truncateAccountIdentifier("verylongusername@example.com", 15);
	assert.equal(shortened, "ve…@example.com");
	assert.ok(visibleWidth(shortened) <= 15);

	const tiny = truncateAccountIdentifier("verylongusername@example.com", 5);
	assert.ok(visibleWidth(tiny) <= 5);
});

test("provider badge switches to cleaner compact variants by width", () => {
	const wide = formatProviderBadge({
		isHidden: false,
		isManual: false,
		visibleCount: 5,
		totalCount: 5,
		maxWidth: 32,
	});
	assert.equal(wide, "[5/5]");

	const manual = formatProviderBadge({
		isHidden: false,
		isManual: true,
		visibleCount: 5,
		totalCount: 5,
		maxWidth: 32,
	});
	assert.equal(manual, "[Manual • 5/5]");

	const hidden = formatProviderBadge({
		isHidden: true,
		isManual: false,
		visibleCount: 0,
		totalCount: 0,
		maxWidth: 10,
	});
	assert.equal(hidden, "[Hid 0/0]");

	const narrow = formatProviderBadge({
		isHidden: true,
		isManual: true,
		visibleCount: 5,
		totalCount: 5,
		maxWidth: 10,
	});
	assert.equal(narrow, "[H M 5/5]");

	const tiny = formatProviderBadge({
		isHidden: false,
		isManual: false,
		visibleCount: 5,
		totalCount: 5,
		maxWidth: 4,
	});
	assert.ok(visibleWidth(tiny) <= 4);
});

test("provider visibility hides zero-credential providers by default", () => {
	const statuses = [
		{
			provider: "openai-codex",
			rotationMode: "round-robin",
			activeIndex: 0,
			credentials: [
				{
					credentialId: "openai-codex",
					credentialType: "oauth",
					redactedSecret: "sk-***",
					index: 0,
					isActive: true,
					isExpired: false,
					usageCount: 0,
					quotaErrorCount: 0,
					expiresAt: null,
				},
			],
		},
		{
			provider: "anthropic",
			rotationMode: "round-robin",
			activeIndex: 0,
			credentials: [],
		},
	] as const;

	const hiddenSummary = summarizeProviderVisibility(statuses, new Set<string>(), false);
	assert.deepEqual(hiddenSummary.displayedStatuses.map((status) => status.provider), ["openai-codex"]);
	assert.equal(hiddenSummary.hiddenStatusCount, 1);
	assert.equal(formatHiddenProviderHint(hiddenSummary), "Press [v] to show 1 provider (empty).");

	const revealedSummary = summarizeProviderVisibility(statuses, new Set<string>(), true);
	assert.deepEqual(revealedSummary.displayedStatuses.map((status) => status.provider), [
		"openai-codex",
		"anthropic",
	]);
});

test("zellij frame strips embedded newlines from cell content", () => {
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};

	const rendered = renderZellijFrame(["[The\nus]"], 12, theme, {
		titleLeft: "",
		focused: true,
	});

	for (const line of rendered.lines) {
		assert.ok(!line.includes("\n"), `line should not contain newline: ${line}`);
		assert.equal(visibleWidth(line), 12);
	}
});

test("provider footer actions expose rotation mode control", () => {
	assert.deepEqual(PROVIDER_FOOTER_ACTIONS, [
		"[Enter] Focus Accounts",
		"[m] Rotation Mode",
		"[t] Refresh Provider",
		"[h] Hide Provider",
		"[v] Show Hidden/Empty",
		"[x] Show Disabled",
		"[←/→] Pane",
		"[Esc] Close",
	]);
});

test("provider add row footer surfaces enter-based add action", () => {
	const actions = resolveFooterActions({
		focusedPane: "providers",
		renameMode: false,
		hasProviderSelection: false,
		hasProviderCredentials: false,
		selectedEntryKind: "none",
		selectedProviderPaneEntryKind: "add",
		selectedProviderHidden: false,
		hasHiddenProviders: false,
		showHiddenProviders: false,
		hasDisabledAccounts: false,
		showDisabledAccounts: false,
		hasBatchSelection: false,
		selectedAccountMarked: false,
	});

	assert.deepEqual(actions, ["[Enter] Add Provider", "[←/→] Pane", "[Esc] Close"]);
});

test("rotation mode labels reflect the actual configured mode", () => {
	assert.equal(formatRotationModeLabel("round-robin"), "Round-Robin Rotation");
	assert.equal(formatRotationModeLabel("usage-based"), "Usage-Based Rotation");
	assert.equal(formatRotationModeLabel("balancer"), "Balancer Rotation");
});
