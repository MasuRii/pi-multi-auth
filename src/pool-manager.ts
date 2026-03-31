import type { CredentialHealthScore } from "./types-health.js";
import {
	DEFAULT_POOL_CONFIG,
	type CredentialPool,
	type PoolHealthAggregate,
	type PoolRotationConfig,
	type PoolSelectionOptions,
	type PoolSelectionResult,
	type ProviderPoolState,
} from "./types-pool.js";

interface AvailablePoolEntry {
	pool: CredentialPool;
	availableCredentialIds: string[];
	aggregate: PoolHealthAggregate;
}

function clonePool(pool: CredentialPool): CredentialPool {
	return {
		...pool,
		credentialIds: [...pool.credentialIds],
		config: pool.config ? { ...pool.config } : undefined,
	};
}

function resolveScore(
	credentialId: string,
	scores: Record<string, CredentialHealthScore> | undefined,
): number {
	const score = scores?.[credentialId]?.score;
	if (typeof score !== "number" || !Number.isFinite(score)) {
		return 1;
	}
	return Math.max(0, Math.min(1, score));
}

function sortPoolsByPriority(left: CredentialPool, right: CredentialPool): number {
	if (left.priority !== right.priority) {
		return left.priority - right.priority;
	}
	return left.poolId.localeCompare(right.poolId);
}

export class PoolManager {
	private config: PoolRotationConfig;

	constructor(config: Partial<PoolRotationConfig> = {}) {
		this.config = {
			...DEFAULT_POOL_CONFIG,
			...config,
			pools: [...(config.pools ?? DEFAULT_POOL_CONFIG.pools)].map(clonePool),
		};
	}

	isEnabled(): boolean {
		return this.config.enablePools === true && this.config.pools.length > 0;
	}

	getPools(): CredentialPool[] {
		return this.config.pools.map(clonePool);
	}

	selectPool(
		availableCredentialIds: readonly string[],
		options: PoolSelectionOptions = {},
	): PoolSelectionResult | null {
		if (!this.isEnabled()) {
			return null;
		}

		const availableSet = new Set(availableCredentialIds);
		const availablePools = this.config.pools
			.map((pool) => this.buildAvailablePoolEntry(pool, availableSet, options.scores))
			.filter((entry): entry is AvailablePoolEntry => entry !== null)
			.sort((left, right) => sortPoolsByPriority(left.pool, right.pool));

		if (availablePools.length === 0) {
			return null;
		}

		switch (this.config.failoverStrategy) {
			case "round-robin":
				return this.selectRoundRobinPool(availablePools, options.state);
			case "health-based":
				return this.selectHealthBasedPool(availablePools, options.state);
			case "priority":
			default:
				return this.finalizeSelection(availablePools[0], options.state, 0, availablePools.length);
		}
	}

	private buildAvailablePoolEntry(
		pool: CredentialPool,
		availableSet: ReadonlySet<string>,
		scores: Record<string, CredentialHealthScore> | undefined,
	): AvailablePoolEntry | null {
		const poolOrder = new Map<string, number>();
		for (let index = 0; index < pool.credentialIds.length; index += 1) {
			poolOrder.set(pool.credentialIds[index], index);
		}

		const sortedCredentials = pool.credentialIds
			.filter((credentialId) => availableSet.has(credentialId))
			.sort((left, right) => {
				if (this.config.preferHealthyWithinPool) {
					const scoreDelta = resolveScore(right, scores) - resolveScore(left, scores);
					if (scoreDelta !== 0) {
						return scoreDelta;
					}
				}
				return (poolOrder.get(left) ?? 0) - (poolOrder.get(right) ?? 0);
			});

		if (sortedCredentials.length === 0) {
			return null;
		}

		return {
			pool,
			availableCredentialIds: sortedCredentials,
			aggregate: this.getPoolHealthAggregate(pool, scores, sortedCredentials),
		};
	}

	private selectRoundRobinPool(
		availablePools: AvailablePoolEntry[],
		state: ProviderPoolState | undefined,
	): PoolSelectionResult {
		const startIndex = Math.max(0, state?.poolIndex ?? 0) % availablePools.length;
		return this.finalizeSelection(
			availablePools[startIndex],
			state,
			(startIndex + 1) % availablePools.length,
			availablePools.length,
		);
	}

	private selectHealthBasedPool(
		availablePools: AvailablePoolEntry[],
		state: ProviderPoolState | undefined,
	): PoolSelectionResult {
		let selected = availablePools[0];
		let selectedIndex = 0;
		for (let index = 1; index < availablePools.length; index += 1) {
			const candidate = availablePools[index];
			if (candidate.aggregate.averageHealth > selected.aggregate.averageHealth) {
				selected = candidate;
				selectedIndex = index;
				continue;
			}
			if (candidate.aggregate.averageHealth === selected.aggregate.averageHealth) {
				const priorityComparison = sortPoolsByPriority(candidate.pool, selected.pool);
				if (priorityComparison < 0) {
					selected = candidate;
					selectedIndex = index;
				}
			}
		}

		return this.finalizeSelection(
			selected,
			state,
			(selectedIndex + 1) % availablePools.length,
			availablePools.length,
		);
	}

	private finalizeSelection(
		entry: AvailablePoolEntry,
		state: ProviderPoolState | undefined,
		nextPoolIndex: number,
		availablePoolCount: number,
	): PoolSelectionResult {
		return {
			pool: clonePool(entry.pool),
			poolHealth: entry.aggregate.averageHealth,
			availableCredentialIds: [...entry.availableCredentialIds],
			poolState: {
				activePoolId: entry.pool.poolId,
				poolIndex: availablePoolCount > 0 ? nextPoolIndex : state?.poolIndex,
			},
		};
	}

	private getPoolHealthAggregate(
		pool: CredentialPool,
		scores: Record<string, CredentialHealthScore> | undefined,
		availableCredentialIds: readonly string[],
	): PoolHealthAggregate {
		const totalCount = availableCredentialIds.length;
		const threshold = pool.healthThreshold ?? 0.5;
		let totalHealth = 0;
		let healthyCount = 0;
		for (const credentialId of availableCredentialIds) {
			const score = resolveScore(credentialId, scores);
			totalHealth += score;
			if (score >= threshold) {
				healthyCount += 1;
			}
		}
		const averageHealth = totalCount > 0 ? totalHealth / totalCount : 0;
		return {
			poolId: pool.poolId,
			averageHealth,
			healthyCount,
			totalCount,
			isDegraded: totalCount > 0 && healthyCount === 0,
		};
	}
}
