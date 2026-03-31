export interface ProviderLike {
	provider: string;
	credentials: readonly unknown[];
}

export type FocusPane = "providers" | "accounts";
export type SelectedEntryKind = "account" | "add" | "none";
export type ProviderPaneEntryKind = "provider" | "add" | "none";

export interface FooterActionOptions {
	focusedPane: FocusPane;
	renameMode: boolean;
	hasProviderSelection: boolean;
	hasProviderCredentials: boolean;
	selectedEntryKind: SelectedEntryKind;
	selectedProviderPaneEntryKind?: ProviderPaneEntryKind;
	selectedProviderHidden: boolean;
	hasHiddenProviders: boolean;
	showHiddenProviders: boolean;
	hasDisabledAccounts: boolean;
	showDisabledAccounts: boolean;
	hasBatchSelection: boolean;
	selectedAccountMarked: boolean;
}

export interface ProviderVisibilitySummary<TStatus extends ProviderLike = ProviderLike> {
	displayedStatuses: readonly TStatus[];
	hiddenStatusCount: number;
	manuallyHiddenCount: number;
	autoHiddenCount: number;
}

function pluralizeProvider(count: number): string {
	return `${count} provider${count === 1 ? "" : "s"}`;
}

function isAutoHiddenStatus(status: Pick<ProviderLike, "credentials">): boolean {
	return status.credentials.length === 0;
}

export function summarizeProviderVisibility<TStatus extends ProviderLike>(
	statuses: readonly TStatus[],
	hiddenProviders: ReadonlySet<string>,
	showHiddenProviders: boolean,
): ProviderVisibilitySummary<TStatus> {
	let manuallyHiddenCount = 0;
	let autoHiddenCount = 0;
	const displayedStatuses = showHiddenProviders
		? statuses
		: statuses.filter((status) => {
			const isManuallyHidden = hiddenProviders.has(status.provider);
			const isAutoHidden = isAutoHiddenStatus(status);
			if (isManuallyHidden) {
				manuallyHiddenCount += 1;
			}
			if (isAutoHidden) {
				autoHiddenCount += 1;
			}
			return !isManuallyHidden && !isAutoHidden;
		});

	if (showHiddenProviders) {
		for (const status of statuses) {
			if (hiddenProviders.has(status.provider)) {
				manuallyHiddenCount += 1;
			}
			if (isAutoHiddenStatus(status)) {
				autoHiddenCount += 1;
			}
		}
	}

	const hiddenProviderIds = new Set<string>();
	for (const status of statuses) {
		if (hiddenProviders.has(status.provider) || isAutoHiddenStatus(status)) {
			hiddenProviderIds.add(status.provider);
		}
	}

	return {
		displayedStatuses,
		hiddenStatusCount: hiddenProviderIds.size,
		manuallyHiddenCount,
		autoHiddenCount,
	};
}

export function formatHiddenProviderHint(summary: Pick<ProviderVisibilitySummary, "hiddenStatusCount" | "manuallyHiddenCount" | "autoHiddenCount">): string | null {
	if (summary.hiddenStatusCount <= 0) {
		return null;
	}

	const descriptor =
		summary.manuallyHiddenCount > 0 && summary.autoHiddenCount > 0
			? "hidden or empty"
			: summary.autoHiddenCount > 0
				? "empty"
				: "hidden";
	return `Press [v] to show ${pluralizeProvider(summary.hiddenStatusCount)} (${descriptor}).`;
}

export function resolveFooterActions(options: FooterActionOptions): string[] {
	if (options.renameMode) {
		return ["[Enter] Save", "[Esc] Cancel Rename"];
	}

	const actions: string[] = [];
	const appendCommonActions = (): void => {
		if (options.hasHiddenProviders || options.showHiddenProviders) {
			actions.push(
				options.showHiddenProviders ? "[v] Hide Hidden/Empty" : "[v] Show Hidden/Empty",
			);
		}
		if (options.hasDisabledAccounts || options.showDisabledAccounts) {
			actions.push(
				options.showDisabledAccounts ? "[x] Hide Disabled" : "[x] Show Disabled",
			);
		}
		actions.push("[←/→] Pane", "[Esc] Close");
	};

	if (options.focusedPane === "providers") {
		const providerPaneEntryKind = options.selectedProviderPaneEntryKind
			?? (options.hasProviderSelection ? "provider" : "none");
		if (providerPaneEntryKind === "provider") {
			actions.push("[Enter] Focus Accounts", "[m] Rotation Mode", "[t] Refresh Provider");
			actions.push(options.selectedProviderHidden ? "[h] Show Provider" : "[h] Hide Provider");
		} else if (providerPaneEntryKind === "add") {
			actions.push("[Enter] Add Provider");
		}
		appendCommonActions();
		return actions;
	}

	if (options.hasProviderSelection) {
		if (options.selectedEntryKind === "account") {
			actions.push(
				"[Enter] Set/Clear Manual Active",
				options.selectedAccountMarked ? "[Space] Unmark" : "[Space] Mark",
				"[r] Rename",
				"[T] Refresh Selected",
				options.hasBatchSelection ? "[d] Delete Marked" : "[d] Delete",
			);
		} else if (options.selectedEntryKind === "add") {
			actions.push("[Enter] Add");
			if (options.hasBatchSelection) {
				actions.push("[d] Delete Marked");
			}
		}

		if (options.hasProviderCredentials) {
			actions.push("[t] Refresh Provider");
		}
	}

	appendCommonActions();
	return actions;
}
