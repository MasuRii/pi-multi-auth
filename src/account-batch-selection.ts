export type BatchDeleteTarget =
	| {
		kind: "account";
		credentialId: string;
	}
	| {
		kind: "add";
	};

export interface BatchDeleteResolution {
	credentialIds: string[];
	usesBatchSelection: boolean;
}

function normalizeCredentialId(credentialId: string): string {
	const normalized = credentialId.trim();
	if (!normalized) {
		throw new Error("Credential ID must be a non-empty string.");
	}
	return normalized;
}

export function pruneBatchSelection(
	selection: ReadonlySet<string> | undefined,
	visibleCredentialIds: readonly string[],
): Set<string> {
	if (!selection || selection.size === 0) {
		return new Set<string>();
	}

	const visible = new Set(visibleCredentialIds.map((credentialId) => normalizeCredentialId(credentialId)));
	const nextSelection = new Set<string>();
	for (const credentialId of selection) {
		const normalizedCredentialId = normalizeCredentialId(credentialId);
		if (visible.has(normalizedCredentialId)) {
			nextSelection.add(normalizedCredentialId);
		}
	}
	return nextSelection;
}

export function toggleBatchSelection(
	selection: ReadonlySet<string> | undefined,
	credentialId: string,
): Set<string> {
	const normalizedCredentialId = normalizeCredentialId(credentialId);
	const nextSelection = new Set<string>();
	for (const existingCredentialId of selection ?? []) {
		nextSelection.add(normalizeCredentialId(existingCredentialId));
	}
	if (nextSelection.has(normalizedCredentialId)) {
		nextSelection.delete(normalizedCredentialId);
		return nextSelection;
	}

	nextSelection.add(normalizedCredentialId);
	return nextSelection;
}

export function resolveBatchDeleteSelection(
	selection: ReadonlySet<string> | undefined,
	target: BatchDeleteTarget,
): BatchDeleteResolution {
	const batchCredentialIds = selection ? [...selection] : [];
	if (batchCredentialIds.length > 0) {
		return {
			credentialIds: batchCredentialIds.map((credentialId) => normalizeCredentialId(credentialId)),
			usesBatchSelection: true,
		};
	}

	if (target.kind === "account") {
		return {
			credentialIds: [normalizeCredentialId(target.credentialId)],
			usesBatchSelection: false,
		};
	}

	return {
		credentialIds: [],
		usesBatchSelection: false,
	};
}
