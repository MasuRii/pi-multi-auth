import type {
	BalancerCredentialState,
	CredentialLease,
	KeyDistributorConfig,
	SelectionContext,
} from "./types.js";

const DEFAULT_TOLERANCE = 2.0;
const MIN_WEIGHT = Number.EPSILON;

/**
 * Runtime shape used by `calculateWeight` for one credential.
 */
export interface WeightedCredentialState {
	credentialId: string;
	usageCount: number;
	activeRequests: number;
	healthScore: number;
}

/**
 * Selection snapshot consumed by `selectBestCredential`.
 */
export interface WeightedSelectorStates {
	credentialIds: readonly string[];
	usageCount: Readonly<Record<string, number>>;
	balancerState: Readonly<BalancerCredentialState>;
	leasesByCredentialId?: Readonly<Record<string, CredentialLease | undefined>>;
}

/**
 * Selection config used by weighted balancer mode.
 */
export interface WeightedSelectorConfig extends KeyDistributorConfig {
	tolerance?: number;
}

/**
 * Calculates the weighted score for a credential.
 *
 * Formula:
 * `weight = (maxUsageCount - credentialUsageCount) + tolerance + 1`
 *
 * Then applies a concurrency penalty so heavily in-flight credentials are less likely.
 */
export function calculateWeight(
	state: WeightedCredentialState,
	maxUsage: number,
	tolerance: number = DEFAULT_TOLERANCE,
): number {
	const usageCount = toNonNegativeNumber(state.usageCount);
	const activeRequests = toNonNegativeNumber(state.activeRequests);
	const safeMaxUsage = toNonNegativeNumber(maxUsage);
	const safeTolerance = Number.isFinite(tolerance)
		? Math.max(0, tolerance)
		: DEFAULT_TOLERANCE;
	const normalizedHealthScore = clampHealthScore(state.healthScore);

	const baseWeight = safeMaxUsage - usageCount + safeTolerance + 1;
	const clampedBaseWeight = Math.max(MIN_WEIGHT, baseWeight);
	const concurrencyPenaltyFactor = 1 / (activeRequests + 1);
	const healthWeightFactor = normalizedHealthScore <= 0 ? 0 : normalizedHealthScore;

	return Math.max(0, clampedBaseWeight * concurrencyPenaltyFactor * healthWeightFactor);
}

/**
 * Selects a candidate using weighted random probability.
 *
 * Higher weight values increase the chance of being selected.
 */
export function weightedRandomSelect<T>(
	candidates: readonly T[],
	weights: readonly number[],
): T | null {
	if (candidates.length === 0 || candidates.length !== weights.length) {
		return null;
	}

	let totalWeight = 0;
	for (const weight of weights) {
		if (Number.isFinite(weight) && weight > 0) {
			totalWeight += weight;
		}
	}
	if (totalWeight <= 0) {
		return null;
	}

	let target = Math.random() * totalWeight;
	let lastPositiveCandidate: T | null = null;
	for (let index = 0; index < candidates.length; index += 1) {
		const weight = weights[index];
		const normalizedWeight = Number.isFinite(weight) && weight > 0 ? weight : 0;
		if (normalizedWeight <= 0) {
			continue;
		}
		lastPositiveCandidate = candidates[index] ?? null;
		target -= normalizedWeight;
		if (target < 0) {
			return lastPositiveCandidate;
		}
	}

	return lastPositiveCandidate;
}

/**
 * Selects the best credential using balancer filtering and weighted random choice.
 *
 * Filtering rules:
 * - Excluded IDs from the request context are skipped
 * - Credentials in active cooldown are skipped
 * - Credentials leased by another session are skipped
 * - Credentials at or above max concurrency are skipped
 */
export function selectBestCredential(
	context: SelectionContext,
	states: WeightedSelectorStates,
	config: WeightedSelectorConfig,
): string | null {
	const now = Date.now();
	const excludedCredentialIds =
		context.excludedIds.length > 0 ? new Set(context.excludedIds) : null;
	const leasesByCredentialId = states.leasesByCredentialId ?? {};
	const maxConcurrentPerKey = Math.max(1, Math.floor(config.maxConcurrentPerKey));
	const tolerance = resolveTolerance(config.tolerance);

	const eligibleCredentials: WeightedCredentialState[] = [];
	let maxUsage = 0;

	for (const credentialId of states.credentialIds) {
		if (excludedCredentialIds?.has(credentialId)) {
			continue;
		}

		const cooldown = states.balancerState.cooldowns[credentialId];
		if (cooldown !== undefined && cooldown.until > now) {
			continue;
		}

		const lease = leasesByCredentialId[credentialId];
		if (isLeasedToAnotherSession(lease, context.requestingSessionId, now)) {
			continue;
		}

		const activeRequests = toNonNegativeNumber(
			states.balancerState.activeRequests[credentialId],
		);
		if (activeRequests >= maxConcurrentPerKey) {
			continue;
		}

		const usageCount = toNonNegativeNumber(states.usageCount[credentialId]);
		maxUsage = Math.max(maxUsage, usageCount);
		eligibleCredentials.push({
			credentialId,
			usageCount,
			activeRequests,
			healthScore: states.balancerState.healthScores?.[credentialId] ?? 1,
		});
	}

	if (eligibleCredentials.length === 0) {
		return null;
	}

	let totalWeight = 0;
	for (const credential of eligibleCredentials) {
		totalWeight += calculateWeight(credential, maxUsage, tolerance);
	}
	if (totalWeight <= 0) {
		return null;
	}

	let target = Math.random() * totalWeight;
	let lastEligibleCredentialId: string | null = null;
	for (const credential of eligibleCredentials) {
		const weight = calculateWeight(credential, maxUsage, tolerance);
		if (weight <= 0) {
			continue;
		}
		lastEligibleCredentialId = credential.credentialId;
		target -= weight;
		if (target < 0) {
			return credential.credentialId;
		}
	}

	return lastEligibleCredentialId;
}

function toNonNegativeNumber(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) {
		return 0;
	}

	return Math.max(0, value);
}

function clampHealthScore(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) {
		return 1;
	}
	return Math.max(0, Math.min(1, value));
}

function resolveTolerance(tolerance: number | undefined): number {
	if (tolerance === undefined || !Number.isFinite(tolerance)) {
		return DEFAULT_TOLERANCE;
	}

	return Math.max(0, tolerance);
}

function isLeasedToAnotherSession(
	lease: CredentialLease | undefined,
	requestingSessionId: string,
	now: number,
): boolean {
	if (lease === undefined) {
		return false;
	}

	if (lease.expiresAt <= now) {
		return false;
	}

	return lease.sessionId !== requestingSessionId;
}
