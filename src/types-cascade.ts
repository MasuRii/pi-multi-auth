import type { CredentialErrorKind } from "./error-classifier.js";

export type CascadeRecoveryAction = "cooldown" | "disable" | "failover" | "none";

export interface CascadeAttempt {
	providerId: string;
	credentialId: string;
	attemptedAt: number;
	errorKind: CredentialErrorKind;
	errorMessage: string;
	recoveryAction: CascadeRecoveryAction;
}

export interface CascadeRetryState {
	cascadeId: string;
	cascadePath: CascadeAttempt[];
	attemptCount: number;
	startedAt: number;
	lastAttemptAt: number;
	nextRetryAt: number;
	isActive: boolean;
}

export interface ProviderCascadeState {
	active?: CascadeRetryState;
	history: CascadeRetryState[];
}

export interface CascadeConfig {
	initialBackoffMs: number;
	maxBackoffMs: number;
	backoffMultiplier: number;
	maxHistoryEntries: number;
}

export const DEFAULT_CASCADE_CONFIG: CascadeConfig = {
	initialBackoffMs: 1_000,
	maxBackoffMs: 5 * 60_000,
	backoffMultiplier: 2,
	maxHistoryEntries: 10,
};
