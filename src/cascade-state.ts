import { randomUUID } from "node:crypto";
import type { CredentialErrorKind } from "./error-classifier.js";
import {
	DEFAULT_CASCADE_CONFIG,
	type CascadeAttempt,
	type CascadeConfig,
	type CascadeRecoveryAction,
	type CascadeRetryState,
	type ProviderCascadeState,
} from "./types-cascade.js";

function cloneCascadeAttempt(attempt: CascadeAttempt): CascadeAttempt {
	return { ...attempt };
}

function cloneCascadeState(state: CascadeRetryState): CascadeRetryState {
	return {
		...state,
		cascadePath: state.cascadePath.map(cloneCascadeAttempt),
	};
}

function cloneProviderCascadeState(state: ProviderCascadeState): ProviderCascadeState {
	return {
		active: state.active ? cloneCascadeState(state.active) : undefined,
		history: state.history.map(cloneCascadeState),
	};
}

export class CascadeStateManager {
	private config: CascadeConfig;
	private readonly cascadeStates = new Map<string, ProviderCascadeState>();

	constructor(config: Partial<CascadeConfig> = {}) {
		this.config = {
			...DEFAULT_CASCADE_CONFIG,
			...config,
		};
	}

	updateConfig(config: Partial<CascadeConfig>): void {
		this.config = {
			...DEFAULT_CASCADE_CONFIG,
			...config,
		};
	}

	hasActiveCascade(providerId: string): boolean {
		return this.getCascadeState(providerId)?.isActive === true;
	}

	getCascadeState(providerId: string): CascadeRetryState | null {
		return this.cascadeStates.get(providerId)?.active ?? null;
	}

	getProviderState(providerId: string): ProviderCascadeState {
		return cloneProviderCascadeState(this.cascadeStates.get(providerId) ?? { history: [] });
	}

	getBlockedCredentialIds(providerId: string, now: number = Date.now()): Set<string> {
		const activeCascade = this.getCascadeState(providerId);
		if (!activeCascade || !activeCascade.isActive || activeCascade.nextRetryAt <= now) {
			return new Set<string>();
		}

		return new Set(activeCascade.cascadePath.map((attempt) => attempt.credentialId));
	}

	isCredentialInCascadePath(providerId: string, credentialId: string): boolean {
		const cascade = this.getCascadeState(providerId);
		if (!cascade) {
			return false;
		}

		return cascade.cascadePath.some((attempt) => attempt.credentialId === credentialId);
	}

	createCascade(
		providerId: string,
		credentialId: string,
		errorKind: CredentialErrorKind,
		errorMessage: string,
		now: number = Date.now(),
	): CascadeRetryState {
		const attempt = this.createAttempt(providerId, credentialId, errorKind, errorMessage, now);
		const cascade: CascadeRetryState = {
			cascadeId: randomUUID(),
			cascadePath: [attempt],
			attemptCount: 1,
			startedAt: now,
			lastAttemptAt: now,
			nextRetryAt: this.calculateNextRetryAt(1, now),
			isActive: true,
		};
		const providerState = this.cascadeStates.get(providerId) ?? { history: [] };
		providerState.active = cascade;
		this.cascadeStates.set(providerId, providerState);
		return cloneCascadeState(cascade);
	}

	recordCascadeAttempt(
		providerId: string,
		credentialId: string,
		errorKind: CredentialErrorKind,
		errorMessage: string,
		now: number = Date.now(),
	): CascadeRetryState {
		const existingCascade = this.getCascadeState(providerId);
		if (!existingCascade) {
			return this.createCascade(providerId, credentialId, errorKind, errorMessage, now);
		}

		const providerState = this.cascadeStates.get(providerId) ?? { history: [] };
		const updated: CascadeRetryState = {
			...existingCascade,
			cascadePath: [
				...existingCascade.cascadePath,
				this.createAttempt(providerId, credentialId, errorKind, errorMessage, now),
			],
			attemptCount: existingCascade.attemptCount + 1,
			lastAttemptAt: now,
			nextRetryAt: this.calculateNextRetryAt(existingCascade.attemptCount + 1, now),
			isActive: true,
		};
		providerState.active = updated;
		this.cascadeStates.set(providerId, providerState);
		return cloneCascadeState(updated);
	}

	clearCascade(providerId: string): void {
		const providerState = this.cascadeStates.get(providerId);
		if (!providerState?.active) {
			return;
		}

		providerState.history.unshift({
			...providerState.active,
			isActive: false,
			cascadePath: providerState.active.cascadePath.map(cloneCascadeAttempt),
		});
		providerState.history = providerState.history.slice(0, this.config.maxHistoryEntries);
		providerState.active = undefined;
	}

	loadFromState(cascadeStates: Record<string, ProviderCascadeState> | undefined): void {
		if (!cascadeStates) {
			return;
		}

		for (const [providerId, state] of Object.entries(cascadeStates)) {
			this.cascadeStates.set(providerId, cloneProviderCascadeState(state));
		}
	}

	exportState(): Record<string, ProviderCascadeState> {
		const exported: Record<string, ProviderCascadeState> = {};
		for (const [providerId, state] of this.cascadeStates.entries()) {
			exported[providerId] = cloneProviderCascadeState(state);
		}
		return exported;
	}

	removeCredential(providerId: string, credentialId: string): void {
		const providerState = this.cascadeStates.get(providerId);
		if (!providerState) {
			return;
		}

		if (providerState.active) {
			providerState.active.cascadePath = providerState.active.cascadePath.filter(
				(attempt) => attempt.credentialId !== credentialId,
			);
			providerState.active.attemptCount = providerState.active.cascadePath.length;
			if (providerState.active.cascadePath.length === 0) {
				providerState.active = undefined;
			}
		}

		providerState.history = providerState.history
			.map((entry) => ({
				...entry,
				cascadePath: entry.cascadePath.filter((attempt) => attempt.credentialId !== credentialId),
				attemptCount: entry.cascadePath.filter((attempt) => attempt.credentialId !== credentialId).length,
			}))
			.filter((entry) => entry.cascadePath.length > 0);
	}

	private createAttempt(
		providerId: string,
		credentialId: string,
		errorKind: CredentialErrorKind,
		errorMessage: string,
		timestamp: number,
	): CascadeAttempt {
		return {
			providerId,
			credentialId,
			attemptedAt: timestamp,
			errorKind,
			errorMessage: errorMessage.trim().slice(0, 500),
			recoveryAction: this.determineRecoveryAction(errorKind),
		};
	}

	private calculateNextRetryAt(attemptCount: number, now: number): number {
		const backoffMs = Math.min(
			this.config.initialBackoffMs * Math.pow(this.config.backoffMultiplier, attemptCount - 1),
			this.config.maxBackoffMs,
		);
		return now + backoffMs;
	}

	private determineRecoveryAction(errorKind: CredentialErrorKind): CascadeRecoveryAction {
		switch (errorKind) {
			case "authentication":
			case "balance_exhausted":
				return "disable";
			case "quota":
			case "quota_weekly":
			case "rate_limit":
				return "cooldown";
			default:
				return "none";
		}
	}
}
