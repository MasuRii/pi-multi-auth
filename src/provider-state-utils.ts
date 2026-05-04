import { cloneJson } from "./json-utils.js";
import type { ProviderRotationState } from "./types.js";

export function cloneProviderState(state: ProviderRotationState): ProviderRotationState {
	return {
		credentialIds: [...state.credentialIds],
		activeIndex: state.activeIndex,
		rotationMode: state.rotationMode,
		manualActiveCredentialId: state.manualActiveCredentialId,
		lastUsedAt: { ...state.lastUsedAt },
		usageCount: { ...state.usageCount },
		quotaErrorCount: { ...state.quotaErrorCount },
		quotaExhaustedUntil: { ...state.quotaExhaustedUntil },
		lastQuotaError: { ...state.lastQuotaError },
		lastTransientError: { ...state.lastTransientError },
		transientErrorCount: { ...state.transientErrorCount },
		weeklyQuotaAttempts: { ...state.weeklyQuotaAttempts },
		friendlyNames: { ...state.friendlyNames },
		disabledCredentials: { ...state.disabledCredentials },
		cascadeState: state.cascadeState ? cloneJson(state.cascadeState) : undefined,
		healthState: state.healthState ? cloneJson(state.healthState) : undefined,
		oauthRefreshScheduled: { ...(state.oauthRefreshScheduled ?? {}) },
		pools: state.pools ? cloneJson(state.pools) : undefined,
		poolConfig: state.poolConfig ? { ...state.poolConfig } : undefined,
		poolState: state.poolState ? { ...state.poolState } : undefined,
		chains: state.chains ? cloneJson(state.chains) : undefined,
		activeChain: state.activeChain ? cloneJson(state.activeChain) : undefined,
		quotaStates: state.quotaStates ? cloneJson(state.quotaStates) : undefined,
		modelIncompatibilities: state.modelIncompatibilities
			? cloneJson(state.modelIncompatibilities)
			: undefined,
	};
}
