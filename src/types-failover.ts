import type { Api } from "@mariozechner/pi-ai";
import type { CredentialErrorKind } from "./error-classifier.js";
import type { SupportedProviderId } from "./types.js";

export interface ChainProviderConfig {
	providerId: SupportedProviderId;
	modelMapping?: Record<string, string>;
	healthThreshold?: number;
	maxAttempts?: number;
}

export interface FailoverChain {
	chainId: string;
	displayName?: string;
	providers: ChainProviderConfig[];
	maxAttemptsPerProvider: number;
	failoverTriggers: CredentialErrorKind[];
	modelMapping?: Record<string, Record<string, string>>;
}

export interface FailedProviderRecord {
	providerId: string;
	failedAt: number;
	reason: string;
	errorKind: CredentialErrorKind;
}

export interface FailoverChainState {
	chainId: string;
	position: number;
	currentProviderId: string;
	attemptsOnCurrentProvider: number;
	failoverReason: string;
	failoverStartedAt: number;
	failedProviders: FailedProviderRecord[];
}

export interface ChainResult {
	chainId: string;
	providerId: SupportedProviderId;
	modelId: string;
	api?: Api;
	position: number;
	isLastProvider: boolean;
}

export interface FailoverChainConfig {
	enabled: boolean;
	chains: FailoverChain[];
}

export const DEFAULT_FAILOVER_TRIGGERS: CredentialErrorKind[] = [
	"quota",
	"quota_weekly",
	"balance_exhausted",
	"authentication",
	"permission",
	"organization_disabled",
];
