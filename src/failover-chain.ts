import {
	DEFAULT_FAILOVER_TRIGGERS,
	type ChainResult,
	type FailoverChain,
	type FailoverChainState,
	type FailedProviderRecord,
} from "./types-failover.js";
import type { CredentialErrorKind } from "./error-classifier.js";
import type { SupportedProviderId } from "./types.js";

function cloneChain(chain: FailoverChain): FailoverChain {
	return {
		...chain,
		providers: chain.providers.map((provider) => ({
			...provider,
			modelMapping: provider.modelMapping ? { ...provider.modelMapping } : undefined,
		})),
		failoverTriggers: [...chain.failoverTriggers],
		modelMapping: chain.modelMapping
			? Object.fromEntries(
				Object.entries(chain.modelMapping).map(([modelId, mapping]) => [modelId, { ...mapping }]),
			)
			: undefined,
	};
}

function cloneState(state: FailoverChainState): FailoverChainState {
	return {
		...state,
		failedProviders: state.failedProviders.map((provider) => ({ ...provider })),
	};
}

export class FailoverChainManager {
	private readonly chains = new Map<string, FailoverChain>();
	private activeState: FailoverChainState | null = null;

	constructor(chains: FailoverChain[] = []) {
		for (const chain of chains) {
			this.chains.set(chain.chainId, cloneChain(chain));
		}
	}

	getChains(): FailoverChain[] {
		return [...this.chains.values()].map(cloneChain);
	}

	loadState(state: FailoverChainState | undefined): void {
		this.activeState = state ? cloneState(state) : null;
	}

	exportState(): FailoverChainState | undefined {
		return this.activeState ? cloneState(this.activeState) : undefined;
	}

	resetChain(): void {
		this.activeState = null;
	}

	shouldFailover(errorKind: CredentialErrorKind): boolean {
		if (this.activeState) {
			const activeChain = this.chains.get(this.activeState.chainId);
			return (activeChain?.failoverTriggers ?? DEFAULT_FAILOVER_TRIGGERS).includes(errorKind);
		}

		return [...this.chains.values()].some((chain) =>
			(chain.failoverTriggers.length > 0 ? chain.failoverTriggers : DEFAULT_FAILOVER_TRIGGERS).includes(
				errorKind,
			),
		);
	}

	getNextInChain(
		currentProviderId: SupportedProviderId,
		failReason: CredentialErrorKind,
		originalModel: string,
	): ChainResult | null {
		const chain = this.resolveChain(currentProviderId, failReason);
		if (!chain) {
			return null;
		}

		const currentPosition = chain.providers.findIndex(
			(provider) => provider.providerId === currentProviderId,
		);
		if (currentPosition < 0) {
			return null;
		}

		const nextPosition = currentPosition + 1;
		const nextProvider = chain.providers[nextPosition];
		if (!nextProvider) {
			this.recordFailure(currentProviderId, failReason, `Chain exhausted for ${currentProviderId}`);
			return null;
		}

		this.recordFailure(currentProviderId, failReason, `Failover from ${currentProviderId}`);
		this.activeState = {
			chainId: chain.chainId,
			position: nextPosition,
			currentProviderId: nextProvider.providerId,
			attemptsOnCurrentProvider: 0,
			failoverReason: failReason,
			failoverStartedAt: this.activeState?.failoverStartedAt ?? Date.now(),
			failedProviders: this.activeState?.failedProviders ?? [],
		};

		return {
			chainId: chain.chainId,
			providerId: nextProvider.providerId,
			modelId: this.mapModel(chain, originalModel, nextPosition),
			position: nextPosition,
			isLastProvider: nextPosition === chain.providers.length - 1,
		};
	}

	private resolveChain(
		currentProviderId: SupportedProviderId,
		failReason: CredentialErrorKind,
	): FailoverChain | null {
		if (this.activeState) {
			const activeChain = this.chains.get(this.activeState.chainId);
			if (!activeChain) {
				return null;
			}
			if (!(activeChain.failoverTriggers.length > 0 ? activeChain.failoverTriggers : DEFAULT_FAILOVER_TRIGGERS).includes(failReason)) {
				return null;
			}
			return activeChain;
		}

		for (const chain of this.chains.values()) {
			const triggers = chain.failoverTriggers.length > 0 ? chain.failoverTriggers : DEFAULT_FAILOVER_TRIGGERS;
			if (!triggers.includes(failReason)) {
				continue;
			}
			if (!chain.providers.some((provider) => provider.providerId === currentProviderId)) {
				continue;
			}
			this.activeState = {
				chainId: chain.chainId,
				position: Math.max(
					0,
					chain.providers.findIndex((provider) => provider.providerId === currentProviderId),
				),
				currentProviderId,
				attemptsOnCurrentProvider: 0,
				failoverReason: failReason,
				failoverStartedAt: Date.now(),
				failedProviders: [],
			};
			return chain;
		}

		return null;
	}

	private recordFailure(
		providerId: SupportedProviderId,
		errorKind: CredentialErrorKind,
		reason: string,
	): void {
		if (!this.activeState) {
			return;
		}

		const failedProvider: FailedProviderRecord = {
			providerId,
			failedAt: Date.now(),
			reason,
			errorKind,
		};
		const existing = this.activeState.failedProviders.filter(
			(record) => record.providerId !== providerId,
		);
		this.activeState.failedProviders = [...existing, failedProvider];
	}

	private mapModel(chain: FailoverChain, originalModel: string, position: number): string {
		const providerConfig = chain.providers[position];
		return (
			providerConfig?.modelMapping?.[originalModel] ??
			chain.modelMapping?.[originalModel]?.[providerConfig.providerId] ??
			originalModel
		);
	}
}
