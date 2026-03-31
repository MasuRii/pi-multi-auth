import type { CredentialErrorKind } from "./error-classifier.js";

export interface CredentialHealthScore {
	credentialId: string;
	score: number;
	calculatedAt: number;
	components: HealthScoreComponents;
	isStale: boolean;
}

export interface HealthScoreComponents {
	successRate: number;
	latencyFactor: number;
	uptimeFactor: number;
	recoveryFactor: number;
}

export interface HealthScoreWeights {
	successRate: number;
	latencyFactor: number;
	uptimeFactor: number;
	recoveryFactor: number;
}

export const DEFAULT_HEALTH_WEIGHTS: HealthScoreWeights = {
	successRate: 0.4,
	latencyFactor: 0.2,
	uptimeFactor: 0.2,
	recoveryFactor: 0.2,
};

export interface HealthRequestRecord {
	timestamp: number;
	success: boolean;
	latencyMs: number;
	errorKind?: CredentialErrorKind;
}

export interface HealthCooldownRecord {
	startedAt: number;
	endedAt: number | null;
	reason: string;
}

export interface HealthMetricsHistory {
	credentialId: string;
	requests: HealthRequestRecord[];
	cooldowns: HealthCooldownRecord[];
	lastScore: number;
	lastCalculatedAt: number;
}

export interface HealthMetricsConfig {
	windowSize: number;
	maxLatencyMs: number;
	uptimeWindowMs: number;
	minRequests: number;
	staleThresholdMs: number;
	weights: HealthScoreWeights;
}

export const DEFAULT_HEALTH_CONFIG: HealthMetricsConfig = {
	windowSize: 100,
	maxLatencyMs: 5_000,
	uptimeWindowMs: 60 * 60_000,
	minRequests: 5,
	staleThresholdMs: 60 * 60_000,
	weights: DEFAULT_HEALTH_WEIGHTS,
};

export interface ProviderHealthState {
	scores: Record<string, CredentialHealthScore>;
	history?: Record<string, HealthMetricsHistory>;
	configHash?: string;
}
