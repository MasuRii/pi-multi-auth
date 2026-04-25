import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { AccountManager } from "./account-manager.js";
import {
	resolveBatchDeleteSelection,
	pruneBatchSelection,
	toggleBatchSelection,
} from "./account-batch-selection.js";
import { runOAuthLoginDialog } from "./oauth-login-flow.js";
import { getErrorMessage } from "./auth-error-utils.js";
import { parseApiKeyBatchInput } from "./credential-display.js";
import { ModalVisibilityController } from "./modal-visibility.js";
import { formatResetCountdown } from "./formatters/bar.js";
import { resolveBorderGlyphs } from "./formatters/charset.js";
import {
	clampRenderedRows,
	renderWrappedFooterActions,
	resolveBodyRowBudget,
	resolveTerminalRows,
	wrapTextToWidth,
} from "./formatters/responsive-modal.js";
import {
	formatProviderBadge,
	normalizeInlineText,
} from "./formatters/multi-auth-display.js";
import {
	formatHiddenProviderHint,
	resolveFooterActions,
	summarizeProviderVisibility,
	type FocusPane,
	type ProviderVisibilitySummary,
	type SelectedEntryKind,
} from "./formatters/modal-ui.js";
import { renderZellijFrameWithRenderer } from "./formatters/zellij-frame.js";
import {
	formatRotationModeLabel,
	resolveDefaultRotationMode,
	resolveSelectableRotationModes,
} from "./rotation-modes.js";
import {
	LEGACY_SUPPORTED_PROVIDERS,
	type CredentialStatus,
	type ProviderStatus,
	type SupportedProviderId,
} from "./types.js";
import type { UsageSnapshot } from "./usage/types.js";

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface RenameEditorState {
	provider: SupportedProviderId;
	credentialId: string;
	input: Input;
}

type SelectedProviderEntry =
	| {
		kind: "account";
		credential: CredentialStatus;
		entryIndex: number;
	}
	| {
		kind: "add";
		entryIndex: number;
	};

type SelectionAnchor =
	| {
		provider: SupportedProviderId;
		kind: "account";
		credentialId: string;
	}
	| {
		provider: SupportedProviderId;
		kind: "add";
	};

const THREE_PANE_MIN_WIDTH = 96;
const GRID_BODY_ROW_COUNT = 22;
const MIN_BODY_ROW_COUNT = 4;
const GRID_CELL_HORIZONTAL_PADDING = 2;
const GRID_VERTICAL_SEPARATOR_COLUMNS = 2;
const MODAL_TITLE_LEFT_MARGIN = 2;
const MODAL_TITLE_BOTTOM_MARGIN_ROWS = 1;
const MODAL_USAGE_CACHE_MAX_AGE_MS = 5 * 60_000;
const BORDER_GLYPHS = resolveBorderGlyphs();
export const CUSTOM_PROVIDER_NAME_OPTION = "__custom_provider__" as const;

type AddProviderMethod = "api_key" | "oauth";
type ProviderStatusSummary = Pick<ProviderStatus, "provider" | "credentials">;

type ProviderChoiceCandidate = {
	provider: SupportedProviderId;
	displayName: string;
	credentialCount: number;
	isConfigured: boolean;
	isSelected: boolean;
};

export interface SmartApiKeyProviderOption {
	provider: SupportedProviderId | typeof CUSTOM_PROVIDER_NAME_OPTION;
	label: string;
	isConfigured: boolean;
	isSelected: boolean;
	credentialCount: number;
}

export interface SmartOAuthProviderOption {
	provider: SupportedProviderId;
	name: string;
	label: string;
	isConfigured: boolean;
	isSelected: boolean;
	credentialCount: number;
}

function formatConfiguredCredentialCount(credentialCount: number): string {
	return `${credentialCount} credential${credentialCount === 1 ? "" : "s"} configured`;
}

function buildProviderChoiceSuffix(candidate: ProviderChoiceCandidate): string {
	const hints: string[] = [];
	if (candidate.isSelected) {
		hints.push("selected");
	}
	if (candidate.credentialCount > 0) {
		hints.push(formatConfiguredCredentialCount(candidate.credentialCount));
	}
	return hints.join(", ");
}

function compareProviderChoiceCandidates(
	a: ProviderChoiceCandidate,
	b: ProviderChoiceCandidate,
): number {
	if (a.isSelected !== b.isSelected) {
		return a.isSelected ? -1 : 1;
	}
	if (a.isConfigured !== b.isConfigured) {
		return a.isConfigured ? -1 : 1;
	}
	const nameCompare = a.displayName.localeCompare(b.displayName, undefined, {
		sensitivity: "base",
	});
	if (nameCompare !== 0) {
		return nameCompare;
	}
	return a.provider.localeCompare(b.provider, undefined, { sensitivity: "base" });
}

function getCredentialCountsByProvider(
	providerStatuses: readonly ProviderStatusSummary[],
): Map<SupportedProviderId, number> {
	const counts = new Map<SupportedProviderId, number>();
	for (const status of providerStatuses) {
		counts.set(status.provider, status.credentials.length);
	}
	return counts;
}

export function buildSmartApiKeyProviderOptions(
	providerStatuses: readonly ProviderStatusSummary[],
	selectedProviderId: SupportedProviderId | null,
): SmartApiKeyProviderOption[] {
	const credentialCounts = getCredentialCountsByProvider(providerStatuses);
	const seenProviders = new Set<SupportedProviderId>();
	const candidates: ProviderChoiceCandidate[] = [];

	for (const status of providerStatuses) {
		const provider = status.provider.trim();
		if (!provider || seenProviders.has(provider)) {
			continue;
		}
		seenProviders.add(provider);
		candidates.push({
			provider,
			displayName: provider,
			credentialCount: credentialCounts.get(provider) ?? 0,
			isConfigured: (credentialCounts.get(provider) ?? 0) > 0,
			isSelected: provider === selectedProviderId,
		});
	}

	const options = candidates
		.sort(compareProviderChoiceCandidates)
		.map<SmartApiKeyProviderOption>((candidate) => {
			const suffix = buildProviderChoiceSuffix(candidate);
			return {
				provider: candidate.provider,
				label: suffix ? `${candidate.provider} — ${suffix}` : candidate.provider,
				isConfigured: candidate.isConfigured,
				isSelected: candidate.isSelected,
				credentialCount: candidate.credentialCount,
			};
		});

	options.push({
		provider: CUSTOM_PROVIDER_NAME_OPTION,
		label: "Use custom provider name…",
		isConfigured: false,
		isSelected: false,
		credentialCount: 0,
	});
	return options;
}

export function buildSmartOAuthProviderOptions(
	oauthProviders: readonly Readonly<{ provider: SupportedProviderId; name: string }>[],
	providerStatuses: readonly ProviderStatusSummary[],
	selectedProviderId: SupportedProviderId | null,
): SmartOAuthProviderOption[] {
	const credentialCounts = getCredentialCountsByProvider(providerStatuses);
	const seenProviders = new Set<SupportedProviderId>();
	const candidates: ProviderChoiceCandidate[] = [];
	const names = new Map<SupportedProviderId, string>();

	for (const oauthProvider of oauthProviders) {
		const provider = oauthProvider.provider.trim();
		if (!provider || seenProviders.has(provider)) {
			continue;
		}
		seenProviders.add(provider);
		const displayName = oauthProvider.name.trim() || provider;
		names.set(provider, displayName);
		candidates.push({
			provider,
			displayName,
			credentialCount: credentialCounts.get(provider) ?? 0,
			isConfigured: (credentialCounts.get(provider) ?? 0) > 0,
			isSelected: provider === selectedProviderId,
		});
	}

	return candidates
		.sort(compareProviderChoiceCandidates)
		.map<SmartOAuthProviderOption>((candidate) => {
			const name = names.get(candidate.provider) ?? candidate.provider;
			const suffix = buildProviderChoiceSuffix(candidate);
			const baseLabel = `${name} (${candidate.provider})`;
			return {
				provider: candidate.provider,
				name,
				label: suffix ? `${baseLabel} — ${suffix}` : baseLabel,
				isConfigured: candidate.isConfigured,
				isSelected: candidate.isSelected,
				credentialCount: candidate.credentialCount,
			};
		});
}

export function normalizeProviderSelectionInput(
	input: string,
	knownProviderIds: readonly SupportedProviderId[],
): { ok: true; value: SupportedProviderId } | { ok: false; message: string } {
	const normalizedInput = input.trim();
	if (!normalizedInput) {
		return { ok: false, message: "Provider name is required." };
	}
	if (/\s/.test(normalizedInput)) {
		return {
			ok: false,
			message: "Provider name cannot contain spaces. Use IDs like 'openrouter' or 'my-provider'.",
		};
	}

	const canonicalProvider = knownProviderIds.find(
		(providerId) => providerId.trim().toLowerCase() === normalizedInput.toLowerCase(),
	);
	return {
		ok: true,
		value: canonicalProvider ?? normalizedInput,
	};
}

export type ProviderPaneEntry =
	| {
		kind: "provider";
		provider: SupportedProviderId;
		entryIndex: number;
	}
	| {
		kind: "add";
		entryIndex: number;
	};

export function buildProviderPaneEntries(
	statuses: readonly Pick<ProviderStatus, "provider">[],
): ProviderPaneEntry[] {
	return [
		...statuses.map<ProviderPaneEntry>((status, entryIndex) => ({
			kind: "provider",
			provider: status.provider,
			entryIndex,
		})),
		{ kind: "add", entryIndex: statuses.length },
	];
}

export function wrapAccountDisplayNameLines(displayName: string, maxWidth: number): string[] {
	const safeWidth = Math.max(1, Math.floor(maxWidth));
	const normalized = normalizeInlineText(displayName).trim();
	if (!normalized) {
		return [""];
	}
	const wrapped = wrapTextToWidth(normalized, safeWidth);
	return wrapped.length > 0 ? wrapped : [normalized];
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function padRight(value: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	const fitted = truncateToWidth(normalizeInlineText(value), width, "…", true);
	const usedWidth = visibleWidth(fitted);
	return `${fitted}${" ".repeat(Math.max(0, width - usedWidth))}`;
}

function getPaneContentWidth(columnWidth: number): number {
	return Math.max(1, columnWidth - GRID_CELL_HORIZONTAL_PADDING * 2);
}

function getScrollableWindow(
	lines: string[],
	selectedIndex: number,
	visibleRowCount: number,
): string[] {
	if (visibleRowCount <= 0 || lines.length <= visibleRowCount) {
		return lines;
	}

	const clampedSelection = clamp(selectedIndex, 0, lines.length - 1);
	const halfWindow = Math.floor(visibleRowCount / 2);
	const maxStart = Math.max(0, lines.length - visibleRowCount);
	const start = clamp(clampedSelection - halfWindow, 0, maxStart);
	return lines.slice(start, start + visibleRowCount);
}

function formatProviderLabel(provider: SupportedProviderId): string {
	switch (provider) {
		case "openai-codex":
			return "openai-codex";
		case "github-copilot":
			return "github-copilot";
		case "google-gemini-cli":
			return "google-gemini";
		case "google-antigravity":
			return "google-antigrav";
		default:
			return provider;
	}
}

function renderProgressBar(percentUsed: number | null, width: number): string {
	if (percentUsed === null || !Number.isFinite(percentUsed)) {
		return `[${"░".repeat(Math.max(4, width))}] n/a`;
	}

	const safeWidth = Math.max(4, width);
	const clampedPercent = clamp(Math.round(percentUsed), 0, 100);
	const filled = Math.round((clampedPercent / 100) * safeWidth);
	const bar = `${"█".repeat(filled)}${"░".repeat(Math.max(0, safeWidth - filled))}`;
	return `[${bar}] ${clampedPercent}%`;
}

interface PaneWidths {
	providers: number;
	accounts: number;
	details: number;
}

function splitPaneWidths(totalWidth: number): PaneWidths {
	const minimumProviders = 16;
	const minimumAccounts = 18;
	const minimumDetails = 36;
	const usable = Math.max(
		minimumProviders + minimumAccounts + minimumDetails,
		totalWidth - GRID_VERTICAL_SEPARATOR_COLUMNS,
	);

	let providers = Math.floor(usable * 0.22);
	let accounts = Math.floor(usable * 0.27);
	let details = usable - providers - accounts;

	if (providers < minimumProviders) {
		const delta = minimumProviders - providers;
		providers += delta;
		details -= delta;
	}
	if (accounts < minimumAccounts) {
		const delta = minimumAccounts - accounts;
		accounts += delta;
		details -= delta;
	}
	if (details < minimumDetails) {
		const delta = minimumDetails - details;
		details += delta;
		if (accounts - delta >= minimumAccounts) {
			accounts -= delta;
		} else {
			const accountShrink = Math.max(0, accounts - minimumAccounts);
			accounts -= accountShrink;
			providers = Math.max(minimumProviders, providers - (delta - accountShrink));
		}
	}

	return { providers, accounts, details };
}

function renderGridCell(content: string, width: number): string {
	const padding = " ".repeat(GRID_CELL_HORIZONTAL_PADDING);
	const inner = getPaneContentWidth(width);
	return `${padding}${padRight(content, inner)}${padding}`;
}

function horizontalRule(width: number): string {
	return BORDER_GLYPHS.horizontal.repeat(Math.max(1, width));
}

function formatCredentialDisplayName(credentialId: string, friendlyName: string | undefined): string {
	const safeCredentialId = normalizeInlineText(credentialId).trim();
	const normalized = normalizeInlineText(friendlyName ?? "").trim();
	if (!normalized || normalized === safeCredentialId) {
		return safeCredentialId;
	}
	return `${normalized} (${safeCredentialId})`;
}

function formatWindowDurationLabel(windowMinutes: number | null): string | null {
	if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
		return null;
	}

	if (windowMinutes % (24 * 60) === 0) {
		const days = windowMinutes / (24 * 60);
		if (days === 1) {
			return "24-hour window";
		}
		return `${days}-day window`;
	}

	if (windowMinutes % 60 === 0) {
		const hours = windowMinutes / 60;
		if (hours === 1) {
			return "1-hour window";
		}
		return `${hours}-hour window`;
	}

	return `${windowMinutes}-minute window`;
}

function resolveUsageWindowLabel(
	snapshot: UsageSnapshot,
	slot: "primary" | "secondary",
): string {
	if (snapshot.provider === "openai-codex" || snapshot.provider === "anthropic") {
		return slot === "primary" ? "5-hour window" : "7-day window (weekly)";
	}

	const window = slot === "primary" ? snapshot.primary : snapshot.secondary;
	const durationLabel = formatWindowDurationLabel(window?.windowMinutes ?? null);
	if (!durationLabel) {
		return slot === "primary" ? "Primary window" : "Secondary window";
	}

	const sameDuration =
		snapshot.primary?.windowMinutes !== null &&
		snapshot.primary?.windowMinutes !== undefined &&
		snapshot.primary?.windowMinutes === snapshot.secondary?.windowMinutes;
	if (sameDuration) {
		return slot === "primary"
			? `${durationLabel} (window 1)`
			: `${durationLabel} (window 2)`;
	}

	return durationLabel;
}

async function loginProviderFromModal(
	ctx: ExtensionCommandContext,
	accountManager: AccountManager,
	provider: SupportedProviderId,
): Promise<{ message: string; credentialId: string }> {
	return runOAuthLoginDialog(ctx, accountManager, provider);
}

async function addApiKeysFromModal(
	accountManager: AccountManager,
	provider: SupportedProviderId,
	apiKeyInput: string,
	allowBatch: boolean,
): Promise<{ message: string; credentialId: string }> {
	const parsedInput = parseApiKeyBatchInput(apiKeyInput, {
		allowMultiple: allowBatch,
	});
	if (!parsedInput.ok) {
		throw new Error(parsedInput.message);
	}

	const successfulAdds: Array<{
		credentialId: string;
		isBackupCredential: boolean;
		credentialIds: string[];
	}> = [];
	const duplicateExistingCredentialIds: string[] = [];
	const failedAdds: Array<{ ordinal: number; message: string }> = [];
	let deduplicatedCount = 0;
	let renumberedCredentialIds = false;
	let latestCredentialIds: string[] = [];
	let lastTouchedCredentialId: string | null = null;

	for (const [index, key] of parsedInput.keys.entries()) {
		try {
			const added = await accountManager.addApiKeyCredential(provider, key);
			latestCredentialIds = added.credentialIds;
			lastTouchedCredentialId = added.credentialId;
			deduplicatedCount += added.deduplicatedCount ?? 0;
			renumberedCredentialIds = renumberedCredentialIds || Boolean(added.renumberedCredentialIds);

			if (added.didAddCredential === false) {
				duplicateExistingCredentialIds.push(added.duplicateOfCredentialId ?? added.credentialId);
				continue;
			}

			successfulAdds.push(added);
		} catch (error: unknown) {
			failedAdds.push({
				ordinal: index + 1,
				message: getErrorMessage(error),
			});
		}
	}

	if (successfulAdds.length === 0 && duplicateExistingCredentialIds.length === 0) {
		const firstError = failedAdds[0]?.message ?? "No API keys were saved.";
		throw new Error(firstError);
	}

	const fallbackCredentialId =
		successfulAdds[successfulAdds.length - 1]?.credentialId ??
		duplicateExistingCredentialIds[0] ??
		lastTouchedCredentialId ??
		latestCredentialIds[0] ??
		provider;
	const totalCredentials = latestCredentialIds.length;

	const addSummary =
		successfulAdds.length > 0
			? successfulAdds.length === 1
				? `API key saved for ${provider}. ${successfulAdds[0]?.isBackupCredential ? `Stored as backup credential ${successfulAdds[0].credentialId}.` : `Stored as primary credential ${successfulAdds[0]?.credentialId}.`} Total credentials: ${totalCredentials}`
				: `Saved ${successfulAdds.length} API keys for ${provider}. Added credentials: ${successfulAdds.map((result) => result.credentialId).join(", ")}. Total credentials: ${totalCredentials}`
			: `No new API keys were added for ${provider}. Total credentials: ${totalCredentials}`;

	const detailParts: string[] = [];
	if (duplicateExistingCredentialIds.length > 0) {
		detailParts.push(
			`Skipped ${duplicateExistingCredentialIds.length} key${duplicateExistingCredentialIds.length === 1 ? "" : "s"} already present in ${provider}.`,
		);
	}
	if (parsedInput.duplicateCount > 0) {
		detailParts.push(
			`Skipped ${parsedInput.duplicateCount} duplicate line${parsedInput.duplicateCount === 1 ? "" : "s"}.`,
		);
	}
	if (deduplicatedCount > 0) {
		detailParts.push(
			`Removed ${deduplicatedCount} existing duplicate credential${deduplicatedCount === 1 ? "" : "s"} from auth.json.`,
		);
	}
	if (renumberedCredentialIds) {
		detailParts.push("Renumbered credential IDs sequentially for this provider.");
	}
	if (parsedInput.ignoredLineCount > 0) {
		detailParts.push(
			`Ignored ${parsedInput.ignoredLineCount} empty/fence line${parsedInput.ignoredLineCount === 1 ? "" : "s"}.`,
		);
	}
	if (failedAdds.length > 0) {
		const failedOrdinals = failedAdds.map((entry) => `#${entry.ordinal}`).join(", ");
		detailParts.push(
			`Failed to save ${failedAdds.length} key${failedAdds.length === 1 ? "" : "s"} (${failedOrdinals}).`,
		);
	}

	return {
		message: detailParts.length > 0 ? `${addSummary} ${detailParts.join(" ")}` : addSummary,
		credentialId: fallbackCredentialId,
	};
}

function createEmptyProviderStatus(provider: SupportedProviderId): ProviderStatus {
	return {
		provider,
		rotationMode: resolveDefaultRotationMode(provider),
		activeIndex: 0,
		manualActiveCredentialId: undefined,
		credentials: [],
	};
}

async function loadAllProviderStatuses(accountManager: AccountManager): Promise<ProviderStatus[]> {
	const providers = await accountManager.getSupportedProviders();
	const settled = await Promise.allSettled(
		providers.map(async (provider) => accountManager.getProviderStatus(provider)),
	);

	return settled.map((result, index) => {
		const provider = providers[index];
		if (result?.status === "fulfilled") {
			return result.value;
		}
		return createEmptyProviderStatus(provider);
	});
}

class MultiAuthManagerModal {
	private statuses: ProviderStatus[];
	private selectedProviderId: SupportedProviderId | null = null;
	private selectedProviderPaneIndex = 0;
	private selectedEntryByProvider = new Map<SupportedProviderId, number>();
	private batchSelectedCredentialIdsByProvider = new Map<SupportedProviderId, Set<string>>();
	private focusedPane: FocusPane = "providers";
	private renameEditor: RenameEditorState | null = null;
	private busyMessage: string | null = null;
	private infoMessage: string | null = null;
	private isBusy = false;
	private usageRefreshEpoch = 0;
	private readonly hiddenProviders: Set<SupportedProviderId>;
	private showHiddenProviders = false;
	private showDisabledAccounts = false;

	constructor(
		private readonly ctx: ExtensionCommandContext,
		private readonly accountManager: AccountManager,
		private readonly theme: ThemeLike,
		private readonly done: () => void,
		private readonly requestRender: () => void,
		private readonly modalVisibility: ModalVisibilityController,
		initialStatuses: ProviderStatus[],
		initialHiddenProviders: SupportedProviderId[],
	) {
		this.statuses = initialStatuses;
		this.hiddenProviders = new Set(initialHiddenProviders);
		this.syncSelectionState(this.statuses[0]?.provider);
		void this.refreshUsageSnapshots();
	}

	private getProviderVisibilitySummary(): ProviderVisibilitySummary<ProviderStatus> {
		return summarizeProviderVisibility(this.statuses, this.hiddenProviders, this.showHiddenProviders);
	}

	private hasAnyDisabledAccounts(): boolean {
		return this.statuses.some((status) =>
			status.credentials.some((credential) => Boolean(credential.disabledError)),
		);
	}

	private resolveNoProviderSelectedLines(): string[] {
		if (this.statuses.length === 0) {
			return ["No providers detected."];
		}

		const hiddenHint = formatHiddenProviderHint(this.getProviderVisibilitySummary());
		if (hiddenHint) {
			return ["No providers shown in the cleaner view.", hiddenHint];
		}

		return ["No provider selected."];
	}

	private getSelectedEntryKind(status: ProviderStatus | null): SelectedEntryKind {
		if (!status) {
			return "none";
		}
		return this.getSelectedEntry(status).kind;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const lines: string[] = [];
		const modalTitle = this.theme.fg(
			"accent",
			this.theme.bold(`${" ".repeat(MODAL_TITLE_LEFT_MARGIN)}Pi Multi Auth`),
		);
		const focusedPaneLabel = this.focusedPane === "providers" ? "Providers" : "Accounts";
		const runtimeStatus = this.busyMessage ?? this.infoMessage ?? `Focused pane: ${focusedPaneLabel}.`;
		const statusLines = this.buildStatusLines(runtimeStatus, safeWidth);
		const footerLines = this.buildFooterLines(safeWidth);
		const reservedRows =
			statusLines.length + footerLines.length + 5 + MODAL_TITLE_BOTTOM_MARGIN_ROWS;
		const bodyRowCount = resolveBodyRowBudget({
			defaultRows: GRID_BODY_ROW_COUNT,
			terminalRows: resolveTerminalRows(),
			reservedRows,
			minimumRows: MIN_BODY_ROW_COUNT,
		});
		const dashboardRows = this.renderDashboardRows(safeWidth, bodyRowCount);

		lines.push(normalizeInlineText(modalTitle));
		for (let index = 0; index < MODAL_TITLE_BOTTOM_MARGIN_ROWS; index += 1) {
			lines.push("");
		}
		for (const row of dashboardRows) {
			lines.push(normalizeInlineText(row));
		}
		lines.push("");
		for (const line of statusLines) {
			const safeLine = normalizeInlineText(line);
			lines.push(this.busyMessage ? this.theme.fg("warning", safeLine) : safeLine);
		}
		lines.push(horizontalRule(safeWidth));
		for (const line of footerLines) {
			lines.push(normalizeInlineText(line));
		}

		return lines;
	}

	private buildStatusLines(runtimeStatus: string, width: number): string[] {
		const lineWidth = Math.max(1, width);
		const wrapped = wrapTextToWidth(`Status: ${runtimeStatus}`, lineWidth);
		const lines = wrapped.length === 0 ? ["Status: idle."] : wrapped;
		const hiddenHint = formatHiddenProviderHint(this.getProviderVisibilitySummary());
		if (hiddenHint && !this.showHiddenProviders) {
			lines.push(...wrapTextToWidth(hiddenHint, lineWidth));
		}
		return lines;
	}

	private buildFooterLines(width: number): string[] {
		const lineWidth = Math.max(1, width);
		const selectedProviderStatus = this.getSelectedProviderStatus();
		const visibilitySummary = this.getProviderVisibilitySummary();
		const actions = resolveFooterActions({
			focusedPane: this.focusedPane,
			renameMode: this.renameEditor !== null,
			hasProviderSelection: selectedProviderStatus !== null,
			hasProviderCredentials: (selectedProviderStatus?.credentials.length ?? 0) > 0,
			selectedEntryKind: this.getSelectedEntryKind(selectedProviderStatus),
			selectedProviderPaneEntryKind: this.getSelectedProviderPaneEntryKind(),
			selectedProviderHidden:
				selectedProviderStatus !== null && this.hiddenProviders.has(selectedProviderStatus.provider),
			hasHiddenProviders: visibilitySummary.hiddenStatusCount > 0,
			showHiddenProviders: this.showHiddenProviders,
			hasDisabledAccounts: this.hasAnyDisabledAccounts(),
			showDisabledAccounts: this.showDisabledAccounts,
			hasBatchSelection:
				selectedProviderStatus !== null && this.getBatchSelectedCredentialIds(selectedProviderStatus).length > 0,
			selectedAccountMarked:
				selectedProviderStatus !== null && this.isSelectedAccountMarked(selectedProviderStatus),
		});
		const wrapped = renderWrappedFooterActions(actions, lineWidth);
		if (wrapped.length === 0) {
			return ["[Esc] Close"];
		}
		return wrapped;
	}

	invalidate(): void {
		// no-op; render is fully state driven.
	}

	handleInput(data: string): void {
		if (this.renameEditor) {
			this.renameEditor.input.handleInput(data);
			this.requestRender();
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}

		if (matchesKey(data, "left")) {
			this.switchPane(-1);
			this.requestRender();
			return;
		}

		if (matchesKey(data, "right")) {
			this.switchPane(1);
			this.requestRender();
			return;
		}

		if (matchesKey(data, "up")) {
			this.moveSelectionInFocusedPane(-1);
			this.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			this.moveSelectionInFocusedPane(1);
			this.requestRender();
			return;
		}

		if (matchesKey(data, "return")) {
			this.activateSelectedEntry();
			return;
		}

		if (matchesKey(data, "a")) {
			this.addForSelectedProvider();
			return;
		}

		if ((data === " " || matchesKey(data, "space")) && this.focusedPane === "accounts") {
			this.toggleSelectedAccountBatchSelection();
			return;
		}

		if (matchesKey(data, "m") && this.focusedPane === "providers") {
			this.changeSelectedProviderRotationMode();
			return;
		}

		if (matchesKey(data, "r")) {
			this.renameSelectedAccount();
			return;
		}

		if (matchesKey(data, "d")) {
			this.deleteSelectedAccount();
			return;
		}

		if (matchesKey(data, "h")) {
			this.toggleSelectedProviderHidden();
			return;
		}

		if (matchesKey(data, "v")) {
			this.toggleShowHiddenProviders();
			return;
		}

		if (matchesKey(data, "x")) {
			this.toggleShowDisabledAccounts();
			return;
		}

		if (matchesKey(data, "e")) {
			this.reenableSelectedAccount();
			return;
		}

		if (matchesKey(data, "shift+t")) {
			this.refreshSelectedAccount();
			return;
		}

		if (matchesKey(data, "t")) {
			this.refreshSelectedProviderAccounts();
			return;
		}
	}

	private renderDashboardRows(availableWidth: number, bodyRowCount: number): string[] {
		if (availableWidth < THREE_PANE_MIN_WIDTH) {
			return this.renderStackedDashboardRows(availableWidth, bodyRowCount);
		}
		return this.renderThreePaneDashboardRows(availableWidth, bodyRowCount);
	}

	private renderThreePaneDashboardRows(availableWidth: number, bodyRowCount: number): string[] {
		const widths = splitPaneWidths(availableWidth);
		const selectedProviderStatus = this.getSelectedProviderStatus();
		const providerLines = this.buildProvidersPaneLines(widths.providers);
		const accountLines = this.buildAccountsPaneLines(selectedProviderStatus, widths.accounts);
		const selectedAccountLineIndex = selectedProviderStatus
			? this.getSelectedAccountLineIndex(selectedProviderStatus, widths.accounts)
			: 0;
		const visibleBodyRowCount = Math.max(MIN_BODY_ROW_COUNT, bodyRowCount);
		const visibleAccountLines = getScrollableWindow(
			accountLines,
			selectedAccountLineIndex,
			visibleBodyRowCount,
		);
		const detailsContentWidth = getPaneContentWidth(widths.details);
		const detailsLines = this.buildDetailsPaneLines(selectedProviderStatus, detailsContentWidth);

		const providerHeaderCell = renderGridCell("Providers", widths.providers);
		const accountProviderLabel = selectedProviderStatus
			? formatProviderLabel(selectedProviderStatus.provider)
			: "none";
		const disabledViewLabel = this.showDisabledAccounts ? "all" : "active";
		const accountTitleText = `Accounts: ${accountProviderLabel} (${disabledViewLabel})`;
		const accountHeaderCell = renderGridCell(accountTitleText, widths.accounts);
		const detailsHeaderCell = renderGridCell("Account Details", widths.details);
		const providerTitle =
			this.focusedPane === "providers"
				? this.theme.fg("accent", this.theme.bold(providerHeaderCell))
				: this.theme.fg("dim", providerHeaderCell);
		const accountTitle =
			this.focusedPane === "accounts"
				? this.theme.fg("accent", this.theme.bold(accountHeaderCell))
				: this.theme.fg("dim", accountHeaderCell);
		const detailsTitle = this.theme.fg("dim", detailsHeaderCell);

		const rows: string[] = [];
		rows.push(`${providerTitle}${BORDER_GLYPHS.vertical}${accountTitle}${BORDER_GLYPHS.vertical}${detailsTitle}`);
		rows.push(this.renderThreePaneDivider(widths, BORDER_GLYPHS.cross));

		for (let index = 0; index < visibleBodyRowCount; index += 1) {
			rows.push(
				this.renderThreePaneRow(
					widths,
					providerLines[index] ?? "",
					visibleAccountLines[index] ?? "",
					detailsLines[index] ?? "",
				),
			);
		}

		rows.push(this.renderThreePaneDivider(widths, BORDER_GLYPHS.teeUp));
		return rows;
	}

	private renderThreePaneRow(
		widths: PaneWidths,
		providerCell: string,
		accountCell: string,
		detailsCell: string,
	): string {
		return `${renderGridCell(providerCell, widths.providers)}${BORDER_GLYPHS.vertical}${renderGridCell(accountCell, widths.accounts)}${BORDER_GLYPHS.vertical}${renderGridCell(detailsCell, widths.details)}`;
	}

	private renderThreePaneDivider(widths: PaneWidths, centerJoint: string): string {
		const leftSegment = horizontalRule(widths.providers);
		const middleSegment = horizontalRule(widths.accounts);
		const rightSegment = horizontalRule(widths.details);
		return `${leftSegment}${centerJoint}${middleSegment}${centerJoint}${rightSegment}`;
	}

	private renderStackedDashboardRows(availableWidth: number, bodyRowCount: number): string[] {
		const selectedProviderStatus = this.getSelectedProviderStatus();
		const width = Math.max(1, availableWidth);
		const rows: string[] = [];
		rows.push(this.theme.fg("dim", "Providers"));
		for (const line of this.buildProvidersPaneLines(width)) {
			rows.push(line);
		}
		rows.push("");
		const providerLabel = selectedProviderStatus
			? formatProviderLabel(selectedProviderStatus.provider)
			: "none";
		const disabledViewLabel = this.showDisabledAccounts ? "all" : "active";
		rows.push(this.theme.fg("dim", `Accounts: ${providerLabel} (${disabledViewLabel})`));
		for (const line of this.buildAccountsPaneLines(selectedProviderStatus, width)) {
			rows.push(line);
		}
		rows.push("");
		rows.push(this.theme.fg("dim", "Account Details"));
		for (const line of this.buildDetailsPaneLines(selectedProviderStatus, Math.max(1, width - 2))) {
			rows.push(line);
		}

		return clampRenderedRows(rows, Math.max(MIN_BODY_ROW_COUNT, bodyRowCount));
	}

	private buildProvidersPaneLines(columnWidth: number): string[] {
		const displayedStatuses = this.getDisplayedStatuses();
		const selectedEntry = this.getSelectedProviderPaneEntry(displayedStatuses);
		const contentWidth = Math.max(1, getPaneContentWidth(columnWidth));
		const lines = displayedStatuses.map((status, entryIndex) => {
			const isSelected =
				selectedEntry.kind === "provider" && selectedEntry.entryIndex === entryIndex;
			const cursor = isSelected ? "▶" : " ";
			const providerLabel = formatProviderLabel(status.provider);
			const shownCount = this.showDisabledAccounts
				? status.credentials.length
				: this.getVisibleCredentials(status).length;
			const badge = formatProviderBadge({
				isHidden: this.hiddenProviders.has(status.provider),
				isManual: Boolean(status.manualActiveCredentialId),
				visibleCount: shownCount,
				totalCount: status.credentials.length,
				maxWidth: Math.max(0, contentWidth - 6),
			});
			if (!badge) {
				return padRight(`${cursor} ${providerLabel}`, contentWidth);
			}

			const leftWidth = Math.max(1, contentWidth - visibleWidth(badge) - 1);
			if (leftWidth < 4) {
				return padRight(`${cursor} ${providerLabel}`, contentWidth);
			}
			const left = padRight(`${cursor} ${providerLabel}`, leftWidth);
			return padRight(`${left} ${badge}`, contentWidth);
		});
		const addCursor = selectedEntry.kind === "add" ? "▶" : " ";
		lines.push(
			padRight(contentWidth < 24 ? `${addCursor} + Add` : `${addCursor} + Add Provider`, contentWidth),
		);
		return lines;
	}

	private buildAccountEntryLines(
		credential: CredentialStatus,
		contentWidth: number,
		isSelected: boolean,
		isMarked: boolean,
	): string[] {
		const state = this.getCredentialState(credential);
		const cursor = isSelected ? "▶" : " ";
		const mark = isMarked ? "*" : " ";
		const authLabel = credential.credentialType === "api_key" ? "KEY" : "OAUTH";
		const prefix =
			contentWidth < 24
				? `${cursor}${mark} ${state.symbol} `
				: `${cursor}${mark} ${state.symbol} [${state.label}/${authLabel}] `;
		const identifierWidth = Math.max(1, contentWidth - visibleWidth(prefix));
		const displayName = formatCredentialDisplayName(credential.credentialId, credential.friendlyName);
		const labelLines = wrapAccountDisplayNameLines(displayName, identifierWidth);
		const continuationPrefix = " ".repeat(visibleWidth(prefix));
		const lines = labelLines.map((labelLine, lineIndex) =>
			padRight(`${lineIndex === 0 ? prefix : continuationPrefix}${labelLine}`, contentWidth),
		);
		if (state.label !== "Exhaust") {
			return lines;
		}
		return lines.map((line) => this.theme.fg("dim", line));
	}

	private buildAccountsPaneLines(status: ProviderStatus | null, columnWidth: number): string[] {
		if (!status) {
			return this.resolveNoProviderSelectedLines();
		}

		const visibleCredentials = this.getVisibleCredentials(status);
		const selectedCredentialIds = new Set(this.getBatchSelectedCredentialIds(status));
		const contentWidth = Math.max(1, getPaneContentWidth(columnWidth));
		const selectedEntryIndex = this.getSelectedEntryIndex(status);
		const lines: string[] = [];
		for (const [index, credential] of visibleCredentials.entries()) {
			lines.push(
				...this.buildAccountEntryLines(
					credential,
					contentWidth,
					index === selectedEntryIndex,
					selectedCredentialIds.has(credential.credentialId),
				),
			);
		}

		const addSelected = selectedEntryIndex === visibleCredentials.length;
		const addCursor = addSelected ? "▶" : " ";
		lines.push(
			padRight(
				contentWidth < 24 ? `${addCursor} + Add` : `${addCursor} + Add Backup Credential`,
				contentWidth,
			),
		);
		return lines;
	}

	private getSelectedAccountLineIndex(status: ProviderStatus, columnWidth: number): number {
		const visibleCredentials = this.getVisibleCredentials(status);
		const selectedEntryIndex = this.getSelectedEntryIndex(status);
		const contentWidth = Math.max(1, getPaneContentWidth(columnWidth));
		let lineIndex = 0;
		for (const [index, credential] of visibleCredentials.entries()) {
			if (index === selectedEntryIndex) {
				return lineIndex;
			}
			lineIndex += this.buildAccountEntryLines(
				credential,
				contentWidth,
				false,
				this.isCredentialBatchSelected(status.provider, credential.credentialId),
			).length;
		}
		return lineIndex;
	}

	private buildDetailsPaneLines(status: ProviderStatus | null, detailWidth: number): string[] {
		if (!status) {
			const lines = this.resolveNoProviderSelectedLines();
			return [lines[0] ?? "Select a provider to see details.", ...(lines[1] ? [lines[1]] : [])];
		}

		const safeDetailWidth = Math.max(1, detailWidth);
		if (safeDetailWidth < 12) {
			return [
				`Provider: ${formatProviderLabel(status.provider)}`,
				"Increase width for account details.",
			];
		}

		const selectedEntry = this.getSelectedEntry(status);
		if (selectedEntry.kind === "add") {
			const visibleCredentials = this.getVisibleCredentials(status);
			const disabledCount = status.credentials.length - visibleCredentials.length;
			const selectedForDeletion = this.getBatchSelectedCredentialIds(status);
			const hasVisibleAccounts = visibleCredentials.length > 0;
			const capabilities = this.accountManager.getProviderCapabilities(status.provider);
			const addHint = capabilities.supportsOAuth
				? "Add backup via API key or OAuth login."
				: "Add backup via API key (batch mode opens a multiline editor; one key per line).";
			const lines = [
				`Provider: ${formatProviderLabel(status.provider)}`,
				`Rotation: ${formatRotationModeLabel(status.rotationMode)}`,
				hasVisibleAccounts ? addHint : `No visible credentials. ${addHint}`,
			];
			if (selectedForDeletion.length > 0) {
				lines.push(
					`Batch delete queue: ${selectedForDeletion.length} account${selectedForDeletion.length === 1 ? "" : "s"} selected. Press [d] to delete them.`,
				);
			}
			if (!this.showDisabledAccounts && disabledCount > 0) {
				lines.push(`Hidden disabled accounts: ${disabledCount}. Press [x] to show them.`);
			}
			lines.push("", "Press [Enter] or [a] to add a backup credential.", "Press [←]/[→] to switch pane focus.");
			return lines;
		}

		const selectedCredential = selectedEntry.credential;
		const batchSelectionCount = this.getBatchSelectedCredentialIds(status).length;
		const state = this.getCredentialState(selectedCredential);
		const planType = selectedCredential.usageSnapshot?.planType ?? "unknown";
		const selectionMode = selectedCredential.isManualActive
			? "Manual active (persists across sessions/restarts)"
			: "Automatic";
		const detailLines: string[] = [
			`Name:      ${formatCredentialDisplayName(selectedCredential.credentialId, selectedCredential.friendlyName)}`,
			`ID:        ${selectedCredential.credentialId}`,
			`Type:      ${selectedCredential.credentialType}`,
			`Auth:      ${selectedCredential.redactedSecret}`,
			`Plan:      ${planType}`,
			`State:     ${state.label}`,
			`Selection: ${selectionMode}`,
			`Marked:    ${this.isCredentialBatchSelected(status.provider, selectedCredential.credentialId) ? "Batch delete queue" : "No"}`,
			`Rotation:  ${formatRotationModeLabel(status.rotationMode)}`,
			`Usage:     ${selectedCredential.usageCount} requests`,
			"",
			`${BORDER_GLYPHS.horizontal.repeat(2)} Usage & Quota ${BORDER_GLYPHS.horizontal.repeat(2)}`,
			...this.buildUsageDetailLines(selectedCredential, safeDetailWidth),
		];
		if (batchSelectionCount > 0) {
			detailLines.push("");
			detailLines.push(
				`Batch delete queue: ${batchSelectionCount} account${batchSelectionCount === 1 ? "" : "s"} selected. Press [Space] to toggle this account and [d] to delete the queue.`,
			);
		}
		if (selectedCredential.disabledError) {
			detailLines.push("");
			detailLines.push(`${BORDER_GLYPHS.horizontal.repeat(2)} Disabled Reason ${BORDER_GLYPHS.horizontal.repeat(2)}`);
			detailLines.push(selectedCredential.disabledError);
			detailLines.push("Press [e] to re-enable this account.");
		}

		// Show cooldown/error details when a credential is exhausted
		const now = Date.now();
		const isExhausted =
			typeof selectedCredential.quotaExhaustedUntil === "number" &&
			selectedCredential.quotaExhaustedUntil > now;
		if (isExhausted && selectedCredential.lastTransientError) {
			detailLines.push("");
			detailLines.push(`${BORDER_GLYPHS.horizontal.repeat(2)} Transient Error ${BORDER_GLYPHS.horizontal.repeat(2)}`);
			detailLines.push(selectedCredential.lastTransientError);
			if (selectedCredential.transientErrorCount && selectedCredential.transientErrorCount > 0) {
				const cooldownSeconds = Math.max(
					1,
					Math.round((selectedCredential.quotaExhaustedUntil! - now) / 1000),
				);
				detailLines.push(`(Transient attempt ${selectedCredential.transientErrorCount}, cooldown: ~${cooldownSeconds}s)`);
			}
		} else if (isExhausted && selectedCredential.lastQuotaError) {
			detailLines.push("");
			detailLines.push(`${BORDER_GLYPHS.horizontal.repeat(2)} Quota Error ${BORDER_GLYPHS.horizontal.repeat(2)}`);
			detailLines.push(selectedCredential.lastQuotaError);
			if (selectedCredential.weeklyQuotaAttempts && selectedCredential.weeklyQuotaAttempts > 0) {
				const cooldownHours = Math.round((selectedCredential.quotaExhaustedUntil! - now) / (60 * 60 * 1000));
				detailLines.push(`(Weekly quota attempt ${selectedCredential.weeklyQuotaAttempts}, cooldown: ~${cooldownHours}h)`);
			}
		}

		if (
			this.renameEditor &&
			this.renameEditor.provider === status.provider &&
			this.renameEditor.credentialId === selectedCredential.credentialId
		) {
			const inputWidth = Math.max(8, safeDetailWidth - 2);
			const inputLine = this.renameEditor.input.render(inputWidth)[0] ?? "";
			return [
				"Rename account (Enter: save, Esc: cancel):",
				`> ${inputLine}`,
				"",
				...detailLines,
			];
		}

		return detailLines;
	}

	private buildUsageDetailLines(credential: CredentialStatus, detailWidth: number): string[] {
		const snapshot = credential.usageSnapshot;
		if (!snapshot) {
			if (credential.usageFetchError) {
				return ["Usage unavailable", credential.usageFetchError];
			}
			return ["Loading usage data..."];
		}

		const barWidth = clamp(Math.floor(detailWidth * 0.45), 10, 26);
		if (snapshot.copilotQuota) {
			const lines: string[] = [];
			const chat = snapshot.copilotQuota.chat;
			lines.push("Chat Completions");
			lines.push(renderProgressBar(chat.percentUsed, barWidth));
			if (chat.unlimited) {
				lines.push("Unlimited (∞)");
			} else if (typeof chat.used === "number" && typeof chat.total === "number") {
				const reset = formatResetCountdown(snapshot.copilotQuota.resetAt);
				const resetText = reset === "n/a" ? "" : ` • Resets in ${reset}`;
				lines.push(`${chat.used}/${chat.total} used${resetText}`);
			}

			const completions = snapshot.copilotQuota.completions;
			if (completions) {
				lines.push("");
				lines.push("Code Completions");
				lines.push(renderProgressBar(completions.percentUsed, barWidth));
				if (completions.unlimited) {
					lines.push("Unlimited (∞)");
				} else if (
					typeof completions.used === "number" &&
					typeof completions.total === "number"
				) {
					lines.push(`${completions.used}/${completions.total} used`);
				}
			}
			return lines;
		}

		const lines: string[] = [];
		if (snapshot.primary) {
			lines.push(resolveUsageWindowLabel(snapshot, "primary"));
			lines.push(renderProgressBar(snapshot.primary.usedPercent, barWidth));
			const reset = formatResetCountdown(snapshot.primary.resetsAt);
			if (reset !== "n/a") {
				lines.push(`Resets in ${reset}`);
			}
		}
		if (snapshot.secondary) {
			if (lines.length > 0) {
				lines.push("");
			}
			lines.push(resolveUsageWindowLabel(snapshot, "secondary"));
			lines.push(renderProgressBar(snapshot.secondary.usedPercent, barWidth));
			const reset = formatResetCountdown(snapshot.secondary.resetsAt);
			if (reset !== "n/a") {
				lines.push(`Resets in ${reset}`);
			}
		}
		if (lines.length === 0) {
			lines.push("Usage unavailable");
		}
		return lines;
	}

	private getCredentialState(credential: CredentialStatus): { symbol: string; label: string } {
		const now = Date.now();
		if (credential.disabledError) {
			return { symbol: "◌", label: "Disabled" };
		}
		if (credential.isManualActive) {
			return { symbol: "◆", label: "Manual" };
		}
		if (credential.isActive) {
			return { symbol: "●", label: "Active" };
		}
		if (credential.isExpired) {
			return { symbol: "◌", label: "Expired" };
		}
		if (
			typeof credential.quotaExhaustedUntil === "number" &&
			credential.quotaExhaustedUntil > now
		) {
			return { symbol: "◌", label: "Exhaust" };
		}
		return { symbol: "○", label: "Ready" };
	}

	private switchPane(direction: -1 | 1): void {
		if (direction > 0) {
			this.focusedPane = this.focusedPane === "providers" ? "accounts" : "providers";
			return;
		}
		this.focusedPane = this.focusedPane === "accounts" ? "providers" : "accounts";
	}

	private moveSelectionInFocusedPane(direction: -1 | 1): void {
		if (this.focusedPane === "providers") {
			this.moveProviderSelection(direction);
			return;
		}
		this.moveAccountSelection(direction);
	}

	private moveProviderSelection(direction: -1 | 1): void {
		const displayedStatuses = this.getDisplayedStatuses();
		const entryCount = this.getProviderPaneEntryCount(displayedStatuses);
		const currentIndex = this.getSelectedProviderPaneEntryIndex(displayedStatuses);
		const nextIndex = (currentIndex + direction + entryCount) % entryCount;
		this.selectedProviderPaneIndex = nextIndex;
		const nextStatus = displayedStatuses[nextIndex];
		if (nextStatus) {
			this.selectedProviderId = nextStatus.provider;
		}
	}

	private moveAccountSelection(direction: -1 | 1): void {
		const status = this.getSelectedProviderStatus();
		if (!status) {
			return;
		}

		const entryCount = this.getEntryCount(status);
		if (entryCount <= 0) {
			return;
		}

		const currentIndex = this.getSelectedEntryIndex(status);
		const nextIndex = (currentIndex + direction + entryCount) % entryCount;
		this.selectedEntryByProvider.set(status.provider, nextIndex);
	}

	private activateSelectedEntry(): void {
		if (this.focusedPane === "providers") {
			const selectedProviderEntry = this.getSelectedProviderPaneEntry();
			if (selectedProviderEntry.kind === "add") {
				this.addProviderFromProvidersPane(this.resolveProviderPaneAddSelection());
				return;
			}
			this.selectedProviderId = selectedProviderEntry.provider;
			this.focusedPane = "accounts";
			this.infoMessage = "Focused Accounts pane.";
			this.requestRender();
			return;
		}

		const status = this.getSelectedProviderStatus();
		if (!status) {
			return;
		}

		const selectedEntry = this.getSelectedEntry(status);
		if (selectedEntry.kind === "add") {
			this.addAccount(status.provider);
			return;
		}

		const selectedCredentialLabel = formatCredentialDisplayName(
			selectedEntry.credential.credentialId,
			selectedEntry.credential.friendlyName,
		);
		const preserveSelection: SelectionAnchor = {
			provider: status.provider,
			kind: "account",
			credentialId: selectedEntry.credential.credentialId,
		};

		if (selectedEntry.credential.disabledError) {
			this.ctx.ui.notify(
				`${selectedCredentialLabel} is disabled and cannot be activated. Press [e] to re-enable it first.`,
				"warning",
			);
			return;
		}

		if (selectedEntry.credential.isManualActive) {
			this.runAction(`Clearing manual active account for ${status.provider}...`, async () => {
				await this.accountManager.clearManualActiveCredential(status.provider);
				await this.reloadStatuses(preserveSelection);
				return `Manual active account lock cleared for ${selectedCredentialLabel}. Extension-managed rotation is now enabled.`;
			});
			return;
		}

		this.runAction(`Setting manual active account for ${status.provider}...`, async () => {
			await this.accountManager.switchActiveCredential(status.provider, selectedEntry.credential.index);
			await this.reloadStatuses(preserveSelection);
			return `Manual active account set to ${selectedCredentialLabel}. This selection now persists across sessions and restarts.`;
		});
	}

	private toggleSelectedProviderHidden(): void {
		const status = this.getSelectedProviderStatus();
		if (!status) {
			this.ctx.ui.notify("No provider selected.", "warning");
			return;
		}

		const shouldHide = !this.hiddenProviders.has(status.provider);
		this.runAction(
			shouldHide ? `Hiding provider ${status.provider}...` : `Showing provider ${status.provider}...`,
			async () => {
				const isHidden = await this.accountManager.setProviderHidden(status.provider, shouldHide);
				if (isHidden) {
					this.hiddenProviders.add(status.provider);
				} else {
					this.hiddenProviders.delete(status.provider);
				}

				this.syncSelectionState(status.provider);
				return isHidden
					? `Provider ${status.provider} is hidden from the modal. Press [v] to temporarily reveal hidden or empty providers.`
					: `Provider ${status.provider} is visible in the modal again.`;
			},
		);
	}

	private changeSelectedProviderRotationMode(): void {
		const status = this.getSelectedProviderStatus();
		if (!status) {
			this.ctx.ui.notify("No provider selected.", "warning");
			return;
		}

		const preserveSelection = this.getCurrentSelectionAnchor() ?? {
			provider: status.provider,
			kind: "add" as const,
		};

		this.runAction(`Updating rotation mode for ${status.provider}...`, async () => {
			return this.modalVisibility.withHidden(async () => {
				const balancerAvailable = await this.accountManager.shouldUseBalancerMode(status.provider);
				const modes = resolveSelectableRotationModes(status.rotationMode, balancerAvailable);
				const options = modes.map((mode) => ({
					mode,
					label:
						mode === status.rotationMode
							? `${formatRotationModeLabel(mode)} (current)`
							: formatRotationModeLabel(mode),
				}));
				const pickedLabel = await this.ctx.ui.select(
					`Rotation mode for ${status.provider}`,
					options.map((option) => option.label),
				);
				if (!pickedLabel) {
					return "Rotation mode change cancelled.";
				}

				const picked = options.find((option) => option.label === pickedLabel);
				if (!picked || picked.mode === status.rotationMode) {
					return "Rotation mode unchanged.";
				}

				await this.accountManager.setRotationMode(status.provider, picked.mode);
				await this.reloadStatuses(preserveSelection);
				return `Rotation mode for ${status.provider} set to ${formatRotationModeLabel(picked.mode)}.`;
			});
		});
	}

	private toggleShowHiddenProviders(): void {
		this.showHiddenProviders = !this.showHiddenProviders;
		this.syncSelectionState(this.selectedProviderId ?? undefined);
		this.infoMessage = this.showHiddenProviders
			? "Showing hidden and empty providers. Press [h] on a provider to unhide it permanently."
			: "Showing only configured providers with credentials.";
		this.requestRender();
	}

	private toggleShowDisabledAccounts(): void {
		this.showDisabledAccounts = !this.showDisabledAccounts;
		this.syncSelectionState(this.selectedProviderId ?? undefined);
		this.infoMessage = this.showDisabledAccounts
			? "Showing disabled accounts."
			: "Hiding disabled accounts.";
		this.requestRender();
	}

	private reenableSelectedAccount(): void {
		if (this.focusedPane === "providers") {
			return;
		}

		const status = this.getSelectedProviderStatus();
		if (!status) {
			return;
		}

		const selectedEntry = this.getSelectedEntry(status);
		if (selectedEntry.kind === "add") {
			return;
		}

		const credential = selectedEntry.credential;
		if (!credential.disabledError) {
			this.ctx.ui.notify("Selected account is not disabled.", "warning");
			return;
		}

		const credentialLabel = formatCredentialDisplayName(credential.credentialId, credential.friendlyName);
		const preserveSelection: SelectionAnchor = {
			provider: status.provider,
			kind: "account",
			credentialId: credential.credentialId,
		};

		this.runAction(`Re-enabling ${credentialLabel}...`, async () => {
			await this.accountManager.reenableCredential(status.provider, credential.credentialId);
			await this.reloadStatuses(preserveSelection);
			return `Re-enabled ${credentialLabel} for ${status.provider}. The account will now participate in rotation.`;
		});
	}

	private addForSelectedProvider(): void {
		if (this.focusedPane === "providers") {
			this.addProviderFromProvidersPane(this.resolveProviderPaneAddSelection());
			return;
		}
		const status = this.getSelectedProviderStatus();
		if (!status) {
			return;
		}
		this.addAccount(status.provider);
	}

	private addProviderFromProvidersPane(selectedProvider: SupportedProviderId): void {
		this.runAction("Adding provider...", async () => {
			return this.modalVisibility.withHidden(async () => {
				const target = await this.promptForProviderPaneAddTarget(selectedProvider);
				if (!target) {
					return "Add provider cancelled.";
				}
				return this.addCredentialForProvider(target.provider, target.method);
			});
		});
	}

	private addAccount(provider: SupportedProviderId): void {
		this.runAction(`Adding credential for ${provider}...`, async () => {
			return this.modalVisibility.withHidden(async () => {
				const selectedMethod = await this.promptForAddMethod(provider);
				if (!selectedMethod) {
					return "Add credential cancelled.";
				}
				return this.addCredentialForProvider(provider, selectedMethod);
			});
		});
	}

	private async promptForAddMethod(provider: SupportedProviderId): Promise<AddProviderMethod | null> {
		const capabilities = this.accountManager.getProviderCapabilities(provider);
		const methods: Array<{ label: string; value: AddProviderMethod }> = [
			{ label: "API key", value: "api_key" },
		];
		if (capabilities.supportsOAuth) {
			methods.push({ label: "OAuth login", value: "oauth" });
		}
		if (methods.length === 1) {
			return methods[0]?.value ?? null;
		}
		return this.selectAddMethod(`Add backup credential for ${provider}`, methods);
	}

	private async promptForProviderPaneAddTarget(
		selectedProvider: SupportedProviderId,
	): Promise<{ provider: SupportedProviderId; method: AddProviderMethod } | null> {
		const selectedMethod = await this.selectAddMethod("Add provider", [
			{ label: "Use API key", value: "api_key" },
			{ label: "Use OAuth login", value: "oauth" },
		]);
		if (!selectedMethod) {
			return null;
		}
		if (selectedMethod === "oauth") {
			const provider = await this.promptForOAuthProviderSelection(selectedProvider);
			return provider ? { provider, method: selectedMethod } : null;
		}
		const provider = await this.promptForApiKeyProviderSelection(selectedProvider);
		return provider ? { provider, method: selectedMethod } : null;
	}

	private async selectAddMethod(
		title: string,
		methods: readonly { label: string; value: AddProviderMethod }[],
	): Promise<AddProviderMethod | null> {
		const pickedLabel = await this.ctx.ui.select(
			title,
			methods.map((method) => method.label),
		);
		if (!pickedLabel) {
			return null;
		}
		return methods.find((method) => method.label === pickedLabel)?.value ?? null;
	}

	private async promptForOAuthProviderSelection(
		selectedProvider: SupportedProviderId,
	): Promise<SupportedProviderId | null> {
		const options = buildSmartOAuthProviderOptions(
			this.accountManager.getAvailableOAuthProviders(),
			this.statuses,
			selectedProvider,
		);
		if (options.length === 0) {
			throw new Error("No OAuth providers are currently available.");
		}
		const pickedLabel = await this.ctx.ui.select(
			"Choose provider to add via OAuth login",
			options.map((option) => option.label),
		);
		if (!pickedLabel) {
			return null;
		}
		const selectedOption = options.find((option) => option.label === pickedLabel);
		if (!selectedOption) {
			throw new Error("Selected OAuth provider is no longer available.");
		}
		return selectedOption.provider;
	}

	private async promptForApiKeyProviderSelection(
		selectedProvider: SupportedProviderId,
	): Promise<SupportedProviderId | null> {
		const options = buildSmartApiKeyProviderOptions(this.statuses, selectedProvider);
		const pickedLabel = await this.ctx.ui.select(
			"Choose provider to add via API key",
			options.map((option) => option.label),
		);
		if (!pickedLabel) {
			return null;
		}
		const selectedOption = options.find((option) => option.label === pickedLabel);
		if (!selectedOption) {
			throw new Error("Selected provider is no longer available.");
		}
		if (selectedOption.provider !== CUSTOM_PROVIDER_NAME_OPTION) {
			return selectedOption.provider;
		}
		return this.promptForCustomApiKeyProvider(selectedProvider);
	}

	private async promptForCustomApiKeyProvider(
		selectedProvider: SupportedProviderId,
	): Promise<SupportedProviderId | null> {
		const providerInput = await this.ctx.ui.input(
			"Enter custom provider name:",
			selectedProvider,
		);
		if (!providerInput) {
			return null;
		}
		const normalizedProvider = normalizeProviderSelectionInput(
			providerInput,
			this.getKnownProviderIds(),
		);
		if (!normalizedProvider.ok) {
			throw new Error(normalizedProvider.message);
		}
		return normalizedProvider.value;
	}

	private getKnownProviderIds(): SupportedProviderId[] {
		const orderedProviders: SupportedProviderId[] = [];
		const pushUnique = (provider: SupportedProviderId): void => {
			if (!provider || orderedProviders.includes(provider)) {
				return;
			}
			orderedProviders.push(provider);
		};
		for (const status of this.statuses) {
			pushUnique(status.provider);
		}
		for (const provider of this.accountManager.getAvailableOAuthProviders()) {
			pushUnique(provider.provider);
		}
		return orderedProviders;
	}

	private async addCredentialForProvider(
		provider: SupportedProviderId,
		method: AddProviderMethod,
	): Promise<string> {
		const result =
			method === "oauth"
				? await loginProviderFromModal(this.ctx, this.accountManager, provider)
				: await this.addApiKeyCredentialForProvider(provider);
		if (!result) {
			return "API key add cancelled.";
		}
		await this.reloadStatuses({
			provider,
			kind: "account",
			credentialId: result.credentialId,
		});
		return result.message;
	}

	private async addApiKeyCredentialForProvider(
		provider: SupportedProviderId,
	): Promise<{ message: string; credentialId: string } | null> {
		const capabilities = this.accountManager.getProviderCapabilities(provider);
		const supportsBatchAdd = !capabilities.supportsOAuth;
		const apiKeyInput = supportsBatchAdd
			? await this.ctx.ui.editor(`Paste API key(s) for ${provider} (one per line):`)
			: await this.ctx.ui.input(`Paste API key for ${provider}:`);
		if (!apiKeyInput) {
			return null;
		}
		return addApiKeysFromModal(this.accountManager, provider, apiKeyInput, supportsBatchAdd);
	}

	private renameSelectedAccount(): void {
		const status = this.getSelectedProviderStatus();
		if (!status) {
			return;
		}
		const selectedEntry = this.getSelectedEntry(status);
		if (selectedEntry.kind !== "account") {
			this.ctx.ui.notify("Select an account to rename.", "warning");
			return;
		}
		this.startRenameEditor(status.provider, selectedEntry.credential);
	}

	private startRenameEditor(provider: SupportedProviderId, credential: CredentialStatus): void {
		if (this.isBusy) {
			this.ctx.ui.notify("Wait for the current action to finish.", "warning");
			return;
		}

		const input = new Input();
		input.focused = true;
		input.setValue(credential.friendlyName ?? credential.credentialId);

		input.onSubmit = (value: string) => {
			const preserveSelection: SelectionAnchor = {
				provider,
				kind: "account",
				credentialId: credential.credentialId,
			};
			this.renameEditor = null;
			this.runAction(`Renaming ${credential.credentialId}...`, async () => {
				const storedValue = await this.accountManager.setFriendlyName(
					provider,
					credential.credentialId,
					value,
				);
				await this.reloadStatuses(preserveSelection);
				return storedValue === credential.credentialId
					? `Account name reset to credential ID (${credential.credentialId}).`
					: `Account renamed to '${storedValue}'.`;
			});
		};

		input.onEscape = () => {
			this.renameEditor = null;
			this.infoMessage = "Rename cancelled.";
			this.requestRender();
		};

		this.renameEditor = {
			provider,
			credentialId: credential.credentialId,
			input,
		};
		this.requestRender();
	}

	private toggleSelectedAccountBatchSelection(): void {
		const status = this.getSelectedProviderStatus();
		if (!status) {
			return;
		}

		const selectedEntry = this.getSelectedEntry(status);
		if (selectedEntry.kind !== "account") {
			this.ctx.ui.notify("Select an account to add or remove it from the batch delete queue.", "warning");
			return;
		}

		const nextSelection = toggleBatchSelection(
			this.getBatchSelectedCredentialIdSet(status),
			selectedEntry.credential.credentialId,
		);
		this.batchSelectedCredentialIdsByProvider.set(status.provider, nextSelection);
		const displayName = formatCredentialDisplayName(
			selectedEntry.credential.credentialId,
			selectedEntry.credential.friendlyName,
		);
		const marked = nextSelection.has(selectedEntry.credential.credentialId);
		this.infoMessage = marked
			? `Marked ${displayName} for batch delete (${nextSelection.size} selected).`
			: nextSelection.size > 0
				? `Removed ${displayName} from the batch delete queue (${nextSelection.size} remaining).`
				: `Removed ${displayName} from the batch delete queue.`;
		this.requestRender();
	}

	private deleteSelectedAccount(): void {
		const status = this.getSelectedProviderStatus();
		if (!status) {
			return;
		}
		const selectedEntry = this.getSelectedEntry(status);
		const deletionTarget =
			selectedEntry.kind === "account"
				? { kind: "account" as const, credentialId: selectedEntry.credential.credentialId }
				: { kind: "add" as const };
		const deletion = resolveBatchDeleteSelection(
			this.getBatchSelectedCredentialIdSet(status),
			deletionTarget,
		);
		if (deletion.credentialIds.length === 0) {
			this.ctx.ui.notify("Select an account to delete or mark accounts with [Space].", "warning");
			return;
		}

		const credentialLabelById = new Map(
			status.credentials.map((credential) => [
				credential.credentialId,
				formatCredentialDisplayName(credential.credentialId, credential.friendlyName),
			]),
		);
		const deletionLabels = deletion.credentialIds.map(
			(credentialId) => credentialLabelById.get(credentialId) ?? credentialId,
		);
		const previewLines = deletionLabels.slice(0, 5).map((label) => `- ${label}`);
		if (deletionLabels.length > previewLines.length) {
			previewLines.push(`- …and ${deletionLabels.length - previewLines.length} more`);
		}
		const busyMessage =
			deletion.credentialIds.length === 1
				? `Deleting ${deletion.credentialIds[0]}...`
				: `Deleting ${deletion.credentialIds.length} accounts from ${status.provider}...`;

		this.runAction(busyMessage, async () => {
			const confirmed = await this.modalVisibility.withHidden(async () => {
				return this.ctx.ui.confirm(
					deletion.credentialIds.length === 1 && !deletion.usesBatchSelection
						? "Delete account"
						: "Delete accounts",
					deletion.credentialIds.length === 1 && !deletion.usesBatchSelection
						? `Remove ${deletionLabels[0]} from ${status.provider}? This deletes the credential from auth.json.`
						: [
							`Remove ${deletion.credentialIds.length} accounts from ${status.provider}? This deletes each credential from auth.json.`,
							...previewLines,
						].join("\n"),
				);
			});
			if (!confirmed) {
				return "Delete cancelled.";
			}

			await this.accountManager.deleteCredentials(status.provider, deletion.credentialIds);
			this.batchSelectedCredentialIdsByProvider.delete(status.provider);
			await this.reloadStatuses({ provider: status.provider, kind: "add" });
			return deletion.credentialIds.length === 1 && !deletion.usesBatchSelection
				? `Deleted account ${deletionLabels[0]}.`
				: `Deleted ${deletion.credentialIds.length} account${deletion.credentialIds.length === 1 ? "" : "s"} from ${status.provider}.`;
		});
	}

	private refreshSelectedAccount(): void {
		const status = this.getSelectedProviderStatus();
		if (!status) {
			return;
		}

		const selectedEntry = this.getSelectedEntry(status);
		if (selectedEntry.kind !== "account") {
			this.ctx.ui.notify("Select an account to refresh with [Shift+T].", "warning");
			return;
		}

		const preserveSelection: SelectionAnchor = {
			provider: status.provider,
			kind: "account",
			credentialId: selectedEntry.credential.credentialId,
		};
		const displayName = formatCredentialDisplayName(
			selectedEntry.credential.credentialId,
			selectedEntry.credential.friendlyName,
		);

		const isApiKeyCredential = selectedEntry.credential.credentialType === "api_key";
		this.runAction(
			isApiKeyCredential
				? `Refreshing usage state for ${selectedEntry.credential.credentialId}...`
				: `Refreshing token for ${selectedEntry.credential.credentialId}...`,
			async () => {
				const refreshResult = !isApiKeyCredential
					? await this.accountManager.refreshCredential(
							status.provider,
							selectedEntry.credential.credentialId,
						)
					: null;
				const usage = await this.accountManager.getCredentialUsageSnapshot(
					status.provider,
					selectedEntry.credential.credentialId,
					{ forceRefresh: true },
				);
				await this.reloadStatuses(preserveSelection);
				if (usage.error) {
					if (isApiKeyCredential) {
						return `Credential checked for ${displayName}. Usage warning: ${usage.error}.`;
					}
					return refreshResult?.disposition === "preserved_active_token"
						? `Refresh endpoint failed for ${displayName}, but the current token is still active. Usage warning: ${usage.error}.`
						: `Token refreshed for ${displayName}. Usage warning: ${usage.error}.`;
				}
				if (isApiKeyCredential) {
					return `Credential checked for ${displayName}.`;
				}
				return refreshResult?.disposition === "preserved_active_token"
					? `Refresh endpoint failed for ${displayName}, but the current token is still active and will continue to be used.`
					: `Token refreshed for ${displayName}.`;
			},
		);
	}

	private refreshSelectedProviderAccounts(): void {
		const status = this.getSelectedProviderStatus();
		if (!status) {
			return;
		}

		if (status.credentials.length === 0) {
			this.ctx.ui.notify(`No accounts available to refresh for ${status.provider}.`, "warning");
			return;
		}

		const preserveSelection = this.getCurrentSelectionAnchor() ?? {
			provider: status.provider,
			kind: "add" as const,
		};

		this.runAction(`Refreshing tokens for ${status.provider} accounts...`, async () => {
			const result = await this.accountManager.refreshProviderCredentials(status.provider);
			await this.reloadStatuses(preserveSelection);

			const refreshedCount = result.refreshedCredentialIds.length;
			const preservedCount = result.preservedCredentialIds.length;
			const failedCount = result.failedCredentials.length;
			const warningCount = result.usageWarnings.length;
			const processedCount = refreshedCount + preservedCount;
			const summary = `Processed ${processedCount}/${result.totalCredentials} account${result.totalCredentials === 1 ? "" : "s"} for ${status.provider}.`;

			const detailParts: string[] = [];
			if (refreshedCount > 0) {
				detailParts.push(`Refreshed: ${result.refreshedCredentialIds.join(", ")}`);
			}
			if (preservedCount > 0) {
				detailParts.push(`Still using current token: ${result.preservedCredentialIds.join(", ")}`);
			}
			if (failedCount > 0) {
				const failedIds = result.failedCredentials.map((item) => item.credentialId).join(", ");
				detailParts.push(`Failed: ${failedIds}`);
			}
			if (warningCount > 0) {
				const warningIds = result.usageWarnings.map((item) => item.credentialId).join(", ");
				detailParts.push(`Usage warnings: ${warningIds}`);
			}

			if (detailParts.length === 0) {
				return summary;
			}

			return `${summary} ${detailParts.join(" • ")}.`;
		});
	}

	private runAction(
		busyMessage: string,
		action: () => Promise<string>,
	): void {
		if (this.isBusy) {
			this.ctx.ui.notify("Another action is already running.", "warning");
			return;
		}

		this.isBusy = true;
		this.busyMessage = busyMessage;
		this.infoMessage = null;
		this.requestRender();

		void action()
			.then((message) => {
				this.infoMessage = message;
				if (message && message !== "Delete cancelled.") {
					this.ctx.ui.notify(message, "info");
				}
			})
			.catch((error: unknown) => {
				const message = getErrorMessage(error);
				this.infoMessage = `Action failed: ${message}`;
				this.ctx.ui.notify(`Multi-auth action failed: ${message}`, "error");
			})
			.finally(() => {
				this.isBusy = false;
				this.busyMessage = null;
				this.requestRender();
			});
	}

	private async refreshUsageSnapshots(): Promise<void> {
		const refreshEpoch = ++this.usageRefreshEpoch;
		const preserveSelection = this.getCurrentSelectionAnchor();
		const usageByCredentialKey = new Map<
			string,
			{ usageSnapshot: CredentialStatus["usageSnapshot"]; usageFetchError?: string }
		>();
		const credentials = this.statuses.flatMap((status) =>
			status.credentials.map((credential) => ({
				provider: status.provider,
				credentialId: credential.credentialId,
			})),
		);
		const refreshCandidates: Array<{ provider: SupportedProviderId; credentialId: string }> = [];

		const applyUsageState = (
			provider: SupportedProviderId,
			credentialId: string,
			usageState: { usageSnapshot: CredentialStatus["usageSnapshot"]; usageFetchError?: string },
		): void => {
			usageByCredentialKey.set(this.getCredentialMapKey(provider, credentialId), usageState);
			if (refreshEpoch !== this.usageRefreshEpoch) {
				return;
			}
			this.setCredentialUsageState(provider, credentialId, usageState);
		};

		const cacheTasks = credentials.map(async ({ provider, credentialId }) => {
			try {
				const usage = await this.accountManager.getCredentialUsageSnapshot(provider, credentialId, {
					allowStale: true,
					maxAgeMs: MODAL_USAGE_CACHE_MAX_AGE_MS,
				});
				applyUsageState(provider, credentialId, {
					usageSnapshot: usage.snapshot,
					usageFetchError: usage.error ?? undefined,
				});
				if (usage.fromCache) {
					refreshCandidates.push({ provider, credentialId });
				}
			} catch (error: unknown) {
				applyUsageState(provider, credentialId, {
					usageSnapshot: null,
					usageFetchError: `Usage unavailable (${getErrorMessage(error)})`,
				});
			}
		});

		await Promise.allSettled(cacheTasks);
		if (refreshEpoch !== this.usageRefreshEpoch) {
			return;
		}

		const freshTasks = refreshCandidates.map(async ({ provider, credentialId }) => {
			try {
				const usage = await this.accountManager.getCredentialUsageSnapshot(provider, credentialId, {
					forceRefresh: true,
				});
				applyUsageState(provider, credentialId, {
					usageSnapshot: usage.snapshot,
					usageFetchError: usage.error ?? undefined,
				});
			} catch (error: unknown) {
				applyUsageState(provider, credentialId, {
					usageSnapshot: null,
					usageFetchError: `Usage unavailable (${getErrorMessage(error)})`,
				});
			}
		});

		await Promise.allSettled(freshTasks);
		if (refreshEpoch !== this.usageRefreshEpoch) {
			return;
		}

		const latestStatuses = await loadAllProviderStatuses(this.accountManager);
		if (refreshEpoch !== this.usageRefreshEpoch) {
			return;
		}

		this.statuses = this.mergeStatusesWithUsage(latestStatuses, usageByCredentialKey);
		this.syncSelectionState(preserveSelection?.provider);
		this.restoreSelection(preserveSelection ?? null);
		this.requestRender();
	}

	private setCredentialUsageState(
		provider: SupportedProviderId,
		credentialId: string,
		usageState: { usageSnapshot: CredentialStatus["usageSnapshot"]; usageFetchError?: string },
	): void {
		let updated = false;
		this.statuses = this.statuses.map((status) => {
			if (status.provider !== provider) {
				return status;
			}

			let credentialUpdated = false;
			const nextCredentials = status.credentials.map((credential) => {
				if (credential.credentialId !== credentialId) {
					return credential;
				}
				credentialUpdated = true;
				return {
					...credential,
					usageSnapshot: usageState.usageSnapshot,
					usageFetchError: usageState.usageFetchError,
				};
			});

			if (!credentialUpdated) {
				return status;
			}

			updated = true;
			return {
				...status,
				credentials: nextCredentials,
			};
		});

		if (updated) {
			this.requestRender();
		}
	}

	private mergeStatusesWithUsage(
		statuses: ProviderStatus[],
		usageByCredentialKey: Map<
			string,
			{ usageSnapshot: CredentialStatus["usageSnapshot"]; usageFetchError?: string }
		>,
	): ProviderStatus[] {
		return statuses.map((status) => ({
			...status,
			credentials: status.credentials.map((credential) => {
				const usageState = usageByCredentialKey.get(
					this.getCredentialMapKey(status.provider, credential.credentialId),
				);
				if (!usageState) {
					return credential;
				}
				return {
					...credential,
					usageSnapshot: usageState.usageSnapshot,
					usageFetchError: usageState.usageFetchError,
				};
			}),
		}));
	}

	private async reloadStatuses(preserveSelection?: SelectionAnchor): Promise<void> {
		const preferredProvider = preserveSelection?.provider ?? this.getSelectedProviderStatus()?.provider;
		this.statuses = await loadAllProviderStatuses(this.accountManager);
		this.syncSelectionState(preferredProvider);
		this.restoreSelection(preserveSelection ?? null);
		if (this.renameEditor) {
			const renameStatus = this.statuses.find(
				(status) => status.provider === this.renameEditor?.provider,
			);
			const stillExists = renameStatus?.credentials.some(
				(credential) => credential.credentialId === this.renameEditor?.credentialId,
			);
			if (!stillExists) {
				this.renameEditor = null;
			}
		}
		this.requestRender();
		void this.refreshUsageSnapshots();
	}

	private getDisplayedStatuses(): readonly ProviderStatus[] {
		return this.getProviderVisibilitySummary().displayedStatuses;
	}

	private getVisibleCredentials(status: ProviderStatus): CredentialStatus[] {
		if (this.showDisabledAccounts) {
			return status.credentials;
		}
		return status.credentials.filter((credential) => !credential.disabledError);
	}

	private getBatchSelectedCredentialIdSet(status: ProviderStatus): Set<string> {
		const visibleCredentialIds = this.getVisibleCredentials(status).map(
			(credential) => credential.credentialId,
		);
		const nextSelection = pruneBatchSelection(
			this.batchSelectedCredentialIdsByProvider.get(status.provider),
			visibleCredentialIds,
		);
		this.batchSelectedCredentialIdsByProvider.set(status.provider, nextSelection);
		return nextSelection;
	}

	private getBatchSelectedCredentialIds(status: ProviderStatus): string[] {
		return [...this.getBatchSelectedCredentialIdSet(status)];
	}

	private isCredentialBatchSelected(
		provider: SupportedProviderId,
		credentialId: string,
	): boolean {
		return this.batchSelectedCredentialIdsByProvider.get(provider)?.has(credentialId) ?? false;
	}

	private isSelectedAccountMarked(status: ProviderStatus): boolean {
		const selectedEntry = this.getSelectedEntry(status);
		return selectedEntry.kind === "account"
			&& this.isCredentialBatchSelected(status.provider, selectedEntry.credential.credentialId);
	}

	private isProviderDisplayed(provider: SupportedProviderId): boolean {
		return this.getDisplayedStatuses().some((status) => status.provider === provider);
	}

	private syncSelectionState(preferredProvider?: SupportedProviderId): void {
		const nextSelection = new Map<SupportedProviderId, number>();
		const nextBatchSelection = new Map<SupportedProviderId, Set<string>>();
		for (const status of this.statuses) {
			const existing = this.selectedEntryByProvider.get(status.provider);
			const fallback = this.defaultEntryIndex(status);
			nextSelection.set(status.provider, this.clampEntryIndex(status, existing ?? fallback));
			nextBatchSelection.set(
				status.provider,
				pruneBatchSelection(
					this.batchSelectedCredentialIdsByProvider.get(status.provider),
					this.getVisibleCredentials(status).map((credential) => credential.credentialId),
				),
			);
		}
		this.selectedEntryByProvider = nextSelection;
		this.batchSelectedCredentialIdsByProvider = nextBatchSelection;

		const displayedStatuses = this.getDisplayedStatuses();
		this.selectedProviderPaneIndex = this.clampProviderPaneEntryIndex(
			this.selectedProviderPaneIndex,
			displayedStatuses,
		);
		if (displayedStatuses.length === 0) {
			this.selectedProviderId = null;
			this.selectedProviderPaneIndex = 0;
			return;
		}

		const displayedProviders = new Set(displayedStatuses.map((status) => status.provider));
		if (preferredProvider && displayedProviders.has(preferredProvider)) {
			this.selectedProviderId = preferredProvider;
		} else if (!(this.selectedProviderId && displayedProviders.has(this.selectedProviderId))) {
			this.selectedProviderId = displayedStatuses[0]?.provider ?? null;
		}

		if (this.selectedProviderPaneIndex < displayedStatuses.length) {
			const selectedProviderIndex = displayedStatuses.findIndex(
				(status) => status.provider === this.selectedProviderId,
			);
			this.selectedProviderPaneIndex = selectedProviderIndex >= 0 ? selectedProviderIndex : 0;
		}
	}

	private restoreSelection(anchor: SelectionAnchor | null): void {
		if (!anchor) {
			return;
		}

		const status = this.statuses.find((item) => item.provider === anchor.provider);
		if (!status) {
			return;
		}

		if (this.isProviderDisplayed(anchor.provider)) {
			this.selectedProviderId = anchor.provider;
		}

		const visibleCredentials = this.getVisibleCredentials(status);
		if (anchor.kind === "add") {
			this.selectedEntryByProvider.set(status.provider, visibleCredentials.length);
			return;
		}

		const accountIndex = visibleCredentials.findIndex(
			(credential) => credential.credentialId === anchor.credentialId,
		);
		if (accountIndex >= 0) {
			this.selectedEntryByProvider.set(status.provider, accountIndex);
		}
	}

	private getCurrentSelectionAnchor(): SelectionAnchor | null {
		const status = this.getSelectedProviderStatus();
		if (!status) {
			return null;
		}

		const entry = this.getSelectedEntry(status);
		if (entry.kind === "add") {
			return { provider: status.provider, kind: "add" };
		}

		return {
			provider: status.provider,
			kind: "account",
			credentialId: entry.credential.credentialId,
		};
	}

	private getSelectedProviderStatus(): ProviderStatus | null {
		const displayedStatuses = this.getDisplayedStatuses();
		if (displayedStatuses.length === 0) {
			return null;
		}

		const selected = this.selectedProviderId
			? displayedStatuses.find((status) => status.provider === this.selectedProviderId)
			: undefined;
		if (selected) {
			return selected;
		}

		this.selectedProviderId = displayedStatuses[0]?.provider ?? null;
		return displayedStatuses[0] ?? null;
	}

	private resolveProviderPaneAddSelection(): SupportedProviderId {
		return this.getSelectedProviderStatus()?.provider
			?? this.getKnownProviderIds()[0]
			?? LEGACY_SUPPORTED_PROVIDERS[0];
	}

	private getProviderPaneEntryCount(
		displayedStatuses: readonly ProviderStatus[] = this.getDisplayedStatuses(),
	): number {
		return buildProviderPaneEntries(displayedStatuses).length;
	}

	private clampProviderPaneEntryIndex(
		index: number,
		displayedStatuses: readonly ProviderStatus[] = this.getDisplayedStatuses(),
	): number {
		const maxIndex = this.getProviderPaneEntryCount(displayedStatuses) - 1;
		if (maxIndex <= 0 || !Number.isInteger(index)) {
			return 0;
		}
		return clamp(index, 0, maxIndex);
	}

	private getSelectedProviderPaneEntryIndex(
		displayedStatuses: readonly ProviderStatus[] = this.getDisplayedStatuses(),
	): number {
		const entryIndex = this.clampProviderPaneEntryIndex(
			this.selectedProviderPaneIndex,
			displayedStatuses,
		);
		this.selectedProviderPaneIndex = entryIndex;
		return entryIndex;
	}

	private getSelectedProviderPaneEntry(
		displayedStatuses: readonly ProviderStatus[] = this.getDisplayedStatuses(),
	): ProviderPaneEntry {
		const selectedEntryIndex = this.getSelectedProviderPaneEntryIndex(displayedStatuses);
		return (
			buildProviderPaneEntries(displayedStatuses)[selectedEntryIndex] ?? {
				kind: "add",
				entryIndex: displayedStatuses.length,
			}
		);
	}

	private getSelectedProviderPaneEntryKind(): ProviderPaneEntry["kind"] {
		return this.getSelectedProviderPaneEntry().kind;
	}

	private getSelectedEntry(status: ProviderStatus): SelectedProviderEntry {
		const visibleCredentials = this.getVisibleCredentials(status);
		const selectedEntryIndex = this.getSelectedEntryIndex(status);
		if (selectedEntryIndex < visibleCredentials.length) {
			const credential = visibleCredentials[selectedEntryIndex];
			if (credential) {
				return {
					kind: "account",
					credential,
					entryIndex: selectedEntryIndex,
				};
			}
		}

		return {
			kind: "add",
			entryIndex: visibleCredentials.length,
		};
	}

	private getSelectedEntryIndex(status: ProviderStatus): number {
		const existing = this.selectedEntryByProvider.get(status.provider);
		const index = this.clampEntryIndex(status, existing ?? this.defaultEntryIndex(status));
		this.selectedEntryByProvider.set(status.provider, index);
		return index;
	}

	private defaultEntryIndex(status: ProviderStatus): number {
		const visibleCredentials = this.getVisibleCredentials(status);
		if (visibleCredentials.length === 0) {
			return 0;
		}

		const activeCredentialId = status.credentials[status.activeIndex]?.credentialId;
		if (activeCredentialId) {
			const visibleActiveIndex = visibleCredentials.findIndex(
				(credential) => credential.credentialId === activeCredentialId,
			);
			if (visibleActiveIndex >= 0) {
				return visibleActiveIndex;
			}
		}

		return 0;
	}

	private clampEntryIndex(status: ProviderStatus, index: number): number {
		const entryCount = this.getEntryCount(status);
		if (entryCount <= 1) {
			return 0;
		}
		if (!Number.isInteger(index)) {
			return 0;
		}
		return Math.max(0, Math.min(entryCount - 1, index));
	}

	private getEntryCount(status: ProviderStatus): number {
		return this.getVisibleCredentials(status).length + 1;
	}

	private getCredentialMapKey(provider: SupportedProviderId, credentialId: string): string {
		return `${provider}:${credentialId}`;
	}
}

async function openMultiAuthModal(
	ctx: ExtensionCommandContext,
	accountManager: AccountManager,
): Promise<void> {
	const [statuses, hiddenProviders] = await Promise.all([
		loadAllProviderStatuses(accountManager),
		accountManager.getHiddenProviders(),
	]);
	const overlayOptions = {
		anchor: "center" as const,
		width: "96%" as const,
		maxHeight: "96%" as const,
		margin: 0,
	};
	const modalVisibility = new ModalVisibilityController();

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const content = new MultiAuthManagerModal(
				ctx,
				accountManager,
				theme,
				() => {
					modalVisibility.detach();
					done();
				},
				() => tui.requestRender(),
				modalVisibility,
				statuses,
				hiddenProviders,
			);

			return {
				render(width: number): string[] {
					const framed = renderZellijFrameWithRenderer(width, theme, {
						titleLeft: "",
						focused: true,
					}, (contentWidth) => content.render(contentWidth));
					return framed.lines;
				},
				invalidate(): void {
					content.invalidate();
				},
				handleInput(data: string): void {
					content.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions,
			onHandle: (handle) => {
				modalVisibility.attach(handle);
			},
		},
	);
}

/**
 * Registers /multi-auth command for unified account management.
 */
export function registerMultiAuthCommands(
	pi: ExtensionAPI,
	accountManager: AccountManager,
): void {
	pi.registerCommand("multi-auth", {
		description: "Open unified multi-auth account manager modal",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /multi-auth", "warning");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/multi-auth requires interactive TUI mode.", "warning");
				return;
			}

			try {
				await openMultiAuthModal(ctx, accountManager);
			} catch (error) {
				ctx.ui.notify(`/multi-auth failed: ${getErrorMessage(error)}`, "error");
			}
		},
	});
}
