import type { ProviderRotationState } from "./types.js";

/**
 * Resolves the next eligible credential index for round-robin rotation.
 */
export function getRoundRobinCandidateIndex(
	state: Pick<ProviderRotationState, "credentialIds" | "activeIndex">,
	available: ReadonlySet<string>,
): number | undefined {
	if (state.credentialIds.length === 0) {
		return undefined;
	}

	for (let offset = 0; offset < state.credentialIds.length; offset += 1) {
		const index = (state.activeIndex + offset) % state.credentialIds.length;
		const credentialId = state.credentialIds[index];
		if (available.has(credentialId)) {
			return index;
		}
	}

	return undefined;
}

/**
 * Resolves the next eligible credential index for usage-based rotation.
 */
export function getUsageBasedCandidateIndex(
	state: Pick<ProviderRotationState, "credentialIds" | "usageCount" | "quotaErrorCount" | "lastUsedAt">,
	available: ReadonlySet<string>,
): number | undefined {
	const candidates = state.credentialIds
		.map((credentialId, index) => ({
			credentialId,
			index,
			usageCount: state.usageCount[credentialId] ?? 0,
			quotaErrorCount: state.quotaErrorCount[credentialId] ?? 0,
			lastUsedAt: state.lastUsedAt[credentialId] ?? 0,
		}))
		.filter((item) => available.has(item.credentialId))
		.sort((left, right) => {
			if (left.quotaErrorCount !== right.quotaErrorCount) {
				return left.quotaErrorCount - right.quotaErrorCount;
			}
			if (left.usageCount !== right.usageCount) {
				return left.usageCount - right.usageCount;
			}
			if (left.lastUsedAt !== right.lastUsedAt) {
				return left.lastUsedAt - right.lastUsedAt;
			}
			return left.index - right.index;
		});

	return candidates[0]?.index;
}
