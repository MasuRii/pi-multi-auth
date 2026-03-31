import type { CredentialErrorKind } from "./error-classifier.js";
import {
	DEFAULT_HEALTH_CONFIG,
	DEFAULT_HEALTH_WEIGHTS,
	type CredentialHealthScore,
	type HealthCooldownRecord,
	type HealthMetricsConfig,
	type HealthMetricsHistory,
	type HealthRequestRecord,
	type HealthScoreComponents,
	type HealthScoreWeights,
	type ProviderHealthState,
} from "./types-health.js";

function clampUnit(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.min(1, value));
}

function cloneRequest(record: HealthRequestRecord): HealthRequestRecord {
	return { ...record };
}

function cloneCooldown(record: HealthCooldownRecord): HealthCooldownRecord {
	return { ...record };
}

function cloneScore(score: CredentialHealthScore): CredentialHealthScore {
	return {
		...score,
		components: { ...score.components },
	};
}

function cloneHistory(history: HealthMetricsHistory): HealthMetricsHistory {
	return {
		...history,
		requests: history.requests.map(cloneRequest),
		cooldowns: history.cooldowns.map(cloneCooldown),
	};
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function normalizeWeight(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeHealthWeights(weights: Partial<HealthScoreWeights> | undefined): HealthScoreWeights {
	return {
		successRate: normalizeWeight(weights?.successRate, DEFAULT_HEALTH_WEIGHTS.successRate),
		latencyFactor: normalizeWeight(weights?.latencyFactor, DEFAULT_HEALTH_WEIGHTS.latencyFactor),
		uptimeFactor: normalizeWeight(weights?.uptimeFactor, DEFAULT_HEALTH_WEIGHTS.uptimeFactor),
		recoveryFactor: normalizeWeight(weights?.recoveryFactor, DEFAULT_HEALTH_WEIGHTS.recoveryFactor),
	};
}

function normalizeHealthConfig(config: Partial<HealthMetricsConfig>): HealthMetricsConfig {
	return {
		windowSize: normalizePositiveInteger(config.windowSize, DEFAULT_HEALTH_CONFIG.windowSize),
		maxLatencyMs: normalizePositiveInteger(config.maxLatencyMs, DEFAULT_HEALTH_CONFIG.maxLatencyMs),
		uptimeWindowMs: normalizePositiveInteger(
			config.uptimeWindowMs,
			DEFAULT_HEALTH_CONFIG.uptimeWindowMs,
		),
		minRequests: normalizePositiveInteger(config.minRequests, DEFAULT_HEALTH_CONFIG.minRequests),
		staleThresholdMs: normalizePositiveInteger(
			config.staleThresholdMs,
			DEFAULT_HEALTH_CONFIG.staleThresholdMs,
		),
		weights: normalizeHealthWeights(config.weights),
	};
}

export class HealthScorer {
	private readonly config: HealthMetricsConfig;
	private readonly histories = new Map<string, HealthMetricsHistory>();
	private readonly scores = new Map<string, CredentialHealthScore>();

	constructor(config: Partial<HealthMetricsConfig> = {}) {
		this.config = normalizeHealthConfig({
			...DEFAULT_HEALTH_CONFIG,
			...config,
			weights: {
				...DEFAULT_HEALTH_WEIGHTS,
				...(config.weights ?? {}),
			},
		});
	}

	recordSuccess(credentialId: string, latencyMs: number, timestamp: number = Date.now()): void {
		this.recordRequest(credentialId, {
			timestamp,
			success: true,
			latencyMs: this.normalizeLatency(latencyMs),
		});
	}

	recordFailure(
		credentialId: string,
		latencyMs: number,
		errorKind: CredentialErrorKind,
		timestamp: number = Date.now(),
	): void {
		this.recordRequest(credentialId, {
			timestamp,
			success: false,
			latencyMs: this.normalizeLatency(latencyMs),
			errorKind,
		});
	}

	recordCooldown(
		credentialId: string,
		reason: string,
		startedAt: number = Date.now(),
	): void {
		const history = this.getOrCreateHistory(credentialId);
		for (let index = history.cooldowns.length - 1; index >= 0; index -= 1) {
			const cooldown = history.cooldowns[index];
			if (cooldown?.endedAt === null) {
				cooldown.endedAt = startedAt;
				break;
			}
		}
		history.cooldowns.push({
			startedAt,
			endedAt: null,
			reason: reason.trim() || "cooldown",
		});
		this.pruneHistory(history);
		this.markScoreStale(credentialId);
	}

	endCooldown(credentialId: string, endedAt: number = Date.now()): void {
		const history = this.histories.get(credentialId);
		if (!history) {
			return;
		}

		for (let index = history.cooldowns.length - 1; index >= 0; index -= 1) {
			const cooldown = history.cooldowns[index];
			if (cooldown.endedAt === null) {
				cooldown.endedAt = Math.max(cooldown.startedAt, endedAt);
				break;
			}
		}
		this.pruneHistory(history);
		this.markScoreStale(credentialId);
	}

	calculateScore(credentialId: string): CredentialHealthScore {
		const history = this.histories.get(credentialId);
		if (!history || history.requests.length < this.config.minRequests) {
			const neutral = this.createNeutralScore(credentialId);
			this.scores.set(credentialId, neutral);
			return neutral;
		}

		this.pruneHistory(history);
		const components: HealthScoreComponents = {
			successRate: this.calculateSuccessRate(history),
			latencyFactor: this.calculateLatencyFactor(history),
			uptimeFactor: this.calculateUptimeFactor(history),
			recoveryFactor: this.calculateRecoveryFactor(history),
		};
		const score = this.combineComponents(components);
		const calculatedAt = Date.now();
		const nextScore: CredentialHealthScore = {
			credentialId,
			score,
			calculatedAt,
			components,
			isStale: false,
		};
		history.lastScore = score;
		history.lastCalculatedAt = calculatedAt;
		this.scores.set(credentialId, nextScore);
		return cloneScore(nextScore);
	}

	getScore(credentialId: string): CredentialHealthScore {
		const cached = this.scores.get(credentialId);
		if (cached && Date.now() - cached.calculatedAt < this.config.staleThresholdMs) {
			return cloneScore(cached);
		}
		if (cached) {
			cached.isStale = true;
		}
		return this.calculateScore(credentialId);
	}

	getScores(credentialIds: readonly string[]): Record<string, CredentialHealthScore> {
		const scores: Record<string, CredentialHealthScore> = {};
		for (const credentialId of credentialIds) {
			scores[credentialId] = this.getScore(credentialId);
		}
		return scores;
	}

	removeCredential(credentialId: string): void {
		this.histories.delete(credentialId);
		this.scores.delete(credentialId);
	}

	loadState(state: ProviderHealthState | undefined): void {
		if (!state) {
			return;
		}

		for (const [credentialId, score] of Object.entries(state.scores ?? {})) {
			this.scores.set(credentialId, cloneScore(score));
		}
		for (const [credentialId, history] of Object.entries(state.history ?? {})) {
			this.histories.set(credentialId, cloneHistory(history));
		}
	}

	exportState(credentialIds?: readonly string[]): ProviderHealthState {
		const allowedIds = credentialIds ? new Set(credentialIds) : null;
		const scores: Record<string, CredentialHealthScore> = {};
		for (const [credentialId, score] of this.scores.entries()) {
			if (allowedIds && !allowedIds.has(credentialId)) {
				continue;
			}
			scores[credentialId] = cloneScore(score);
		}
		const history: Record<string, HealthMetricsHistory> = {};
		for (const [credentialId, entry] of this.histories.entries()) {
			if (allowedIds && !allowedIds.has(credentialId)) {
				continue;
			}
			history[credentialId] = cloneHistory(entry);
		}
		return {
			scores,
			history,
			configHash: JSON.stringify(this.config),
		};
	}

	private recordRequest(credentialId: string, request: HealthRequestRecord): void {
		const history = this.getOrCreateHistory(credentialId);
		history.requests.push(request);
		this.pruneHistory(history);
		this.markScoreStale(credentialId);
	}

	private getOrCreateHistory(credentialId: string): HealthMetricsHistory {
		const existing = this.histories.get(credentialId);
		if (existing) {
			return existing;
		}

		const created: HealthMetricsHistory = {
			credentialId,
			requests: [],
			cooldowns: [],
			lastScore: 0,
			lastCalculatedAt: 0,
		};
		this.histories.set(credentialId, created);
		return created;
	}

	private markScoreStale(credentialId: string): void {
		const existing = this.scores.get(credentialId);
		if (existing) {
			existing.isStale = true;
		}
	}

	private pruneHistory(history: HealthMetricsHistory): void {
		const overflow = history.requests.length - this.config.windowSize;
		if (overflow > 0) {
			history.requests.splice(0, overflow);
		}

		const now = Date.now();
		const cutoff = now - this.config.uptimeWindowMs;
		let writeIndex = 0;
		for (const cooldown of history.cooldowns) {
			const endedAt = cooldown.endedAt ?? now;
			if (endedAt < cutoff) {
				continue;
			}
			history.cooldowns[writeIndex] = cooldown;
			writeIndex += 1;
		}
		history.cooldowns.length = writeIndex;
	}

	private calculateSuccessRate(history: HealthMetricsHistory): number {
		if (history.requests.length === 0) {
			return 0.5;
		}

		let successCount = 0;
		for (const request of history.requests) {
			if (request.success) {
				successCount += 1;
			}
		}
		return clampUnit(successCount / history.requests.length);
	}

	private calculateLatencyFactor(history: HealthMetricsHistory): number {
		let successfulRequestCount = 0;
		let totalLatency = 0;
		for (const request of history.requests) {
			if (!request.success) {
				continue;
			}
			successfulRequestCount += 1;
			totalLatency += request.latencyMs;
		}
		if (successfulRequestCount === 0) {
			return 0.5;
		}

		const averageLatency = totalLatency / successfulRequestCount;
		return clampUnit(1 - averageLatency / this.config.maxLatencyMs);
	}

	private calculateUptimeFactor(history: HealthMetricsHistory): number {
		const now = Date.now();
		const windowStart = now - this.config.uptimeWindowMs;
		let cooldownMs = 0;

		for (const cooldown of history.cooldowns) {
			const start = Math.max(windowStart, cooldown.startedAt);
			const end = Math.min(cooldown.endedAt ?? now, now);
			if (end > start) {
				cooldownMs += end - start;
			}
		}

		return clampUnit(1 - cooldownMs / this.config.uptimeWindowMs);
	}

	private calculateRecoveryFactor(history: HealthMetricsHistory): number {
		const recentRequestCount = Math.min(10, history.requests.length);
		if (recentRequestCount < 5) {
			return 0.5;
		}

		let streak = 0;
		for (let index = history.requests.length - 1; index >= history.requests.length - recentRequestCount; index -= 1) {
			if (!history.requests[index]?.success) {
				break;
			}
			streak += 1;
		}
		return clampUnit(streak / 10);
	}

	private combineComponents(components: HealthScoreComponents): number {
		return clampUnit(
			components.successRate * this.config.weights.successRate +
				components.latencyFactor * this.config.weights.latencyFactor +
				components.uptimeFactor * this.config.weights.uptimeFactor +
				components.recoveryFactor * this.config.weights.recoveryFactor,
		);
	}

	private createNeutralScore(credentialId: string): CredentialHealthScore {
		const calculatedAt = Date.now();
		return {
			credentialId,
			score: 0.6,
			calculatedAt,
			components: {
				successRate: 0.5,
				latencyFactor: 0.5,
				uptimeFactor: 1,
				recoveryFactor: 0.5,
			},
			isStale: false,
		};
	}

	private normalizeLatency(latencyMs: number): number {
		if (!Number.isFinite(latencyMs) || latencyMs < 0) {
			return this.config.maxLatencyMs;
		}
		return latencyMs;
	}
}
