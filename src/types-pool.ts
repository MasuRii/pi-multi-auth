import type { RotationMode } from "./types.js";
import type { CredentialHealthScore } from "./types-health.js";

/** @experimental Credential pool definition. */
export interface CredentialPool {
	poolId: string;
	displayName?: string;
	credentialIds: string[];
	priority: number;
	poolMode: RotationMode;
	maxConcurrent?: number;
	healthThreshold?: number;
	config?: PoolConfigOverrides;
}

/** @experimental Pool-level tuning overrides. */
export interface PoolConfigOverrides {
	cooldownMs?: number;
	backoffMultiplier?: number;
}

/** @experimental Pool rotation configuration. */
export interface PoolRotationConfig {
	enablePools: boolean;
	pools: CredentialPool[];
	failoverStrategy: "priority" | "round-robin" | "health-based";
	preferHealthyWithinPool: boolean;
}

/** Persisted provider-level pool options stored alongside pool definitions. */
export type ProviderPoolConfig = Pick<
	PoolRotationConfig,
	"enablePools" | "failoverStrategy" | "preferHealthyWithinPool"
>;

/** @experimental Persisted pool selection state. */
export interface ProviderPoolState {
	activePoolId?: string;
	poolIndex?: number;
}

/** @experimental Pool health aggregate. */
export interface PoolHealthAggregate {
	poolId: string;
	averageHealth: number;
	healthyCount: number;
	totalCount: number;
	isDegraded: boolean;
}

/** @experimental Pool selection result. */
export interface PoolSelectionResult {
	pool: CredentialPool;
	poolHealth?: number;
	availableCredentialIds: string[];
	poolState: ProviderPoolState;
}

export interface PoolSelectionOptions {
	scores?: Record<string, CredentialHealthScore>;
	state?: ProviderPoolState;
}

export const DEFAULT_POOL_CONFIG: PoolRotationConfig = {
	enablePools: false,
	pools: [],
	failoverStrategy: "priority",
	preferHealthyWithinPool: true,
};

export const DEFAULT_PROVIDER_POOL_CONFIG: ProviderPoolConfig = {
	enablePools: true,
	failoverStrategy: DEFAULT_POOL_CONFIG.failoverStrategy,
	preferHealthyWithinPool: DEFAULT_POOL_CONFIG.preferHealthyWithinPool,
};
