import { multiAuthDebugLogger } from "./debug-logger.js";
import { cloneJson, haveSameJsonValue } from "./json-utils.js";
import type {
	LightweightSelectionUpdate,
	LightweightTelemetryUpdate,
} from "./provider-rotation-profile.js";
import { getProviderState, MultiAuthStorage } from "./storage.js";
import type { ProviderCascadeState } from "./types-cascade.js";
import type { ProviderHealthState } from "./types-health.js";
import type { ProviderPoolState } from "./types-pool.js";
import type { ProviderRotationState, SupportedProviderId } from "./types.js";

const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_PENDING_SELECTIONS = 16;

export interface LightweightRotationStateOptions {
	flushIntervalMs?: number;
	maxPendingSelections?: number;
}

type PendingLightweightProviderState = {
	credentialIds: string[];
	usageCountDeltas: Record<string, number>;
	lastUsedAt: Record<string, number>;
	activeIndex?: number;
	activeIndexUpdatedAt?: number;
	poolState?: ProviderPoolState;
	poolStateUpdatedAt?: number;
	cascadeState?: Record<string, ProviderCascadeState>;
	healthState?: ProviderHealthState;
	telemetryUpdatedAt?: number;
	pendingSelectionCount: number;
};

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return Math.max(1, Math.trunc(value));
}

function trimNumberRecord(record: Record<string, number>, validCredentialIds: Set<string>): void {
	for (const credentialId of Object.keys(record)) {
		if (!validCredentialIds.has(credentialId)) {
			delete record[credentialId];
		}
	}
}

function createPendingState(credentialIds: readonly string[]): PendingLightweightProviderState {
	return {
		credentialIds: [...credentialIds],
		usageCountDeltas: {},
		lastUsedAt: {},
		pendingSelectionCount: 0,
	};
}

function reconcilePendingState(
	pendingState: PendingLightweightProviderState,
	credentialIds: readonly string[],
): void {
	pendingState.credentialIds = [...credentialIds];
	const validCredentialIds = new Set(credentialIds);
	trimNumberRecord(pendingState.usageCountDeltas, validCredentialIds);
	trimNumberRecord(pendingState.lastUsedAt, validCredentialIds);
	if (
		typeof pendingState.activeIndex === "number" &&
		(pendingState.activeIndex < 0 || pendingState.activeIndex >= credentialIds.length)
	) {
		pendingState.activeIndex = credentialIds.length === 0 ? 0 : credentialIds.length - 1;
	}
}

function mergePendingState(
	target: PendingLightweightProviderState,
	source: PendingLightweightProviderState,
): void {
	reconcilePendingState(target, source.credentialIds);
	for (const [credentialId, delta] of Object.entries(source.usageCountDeltas)) {
		target.usageCountDeltas[credentialId] = (target.usageCountDeltas[credentialId] ?? 0) + delta;
	}
	for (const [credentialId, lastUsedAt] of Object.entries(source.lastUsedAt)) {
		target.lastUsedAt[credentialId] = Math.max(target.lastUsedAt[credentialId] ?? 0, lastUsedAt);
	}
	if (
		typeof source.activeIndexUpdatedAt === "number" &&
		(source.activeIndexUpdatedAt ?? 0) >= (target.activeIndexUpdatedAt ?? 0)
	) {
		target.activeIndex = source.activeIndex;
		target.activeIndexUpdatedAt = source.activeIndexUpdatedAt;
	}
	if (
		typeof source.poolStateUpdatedAt === "number" &&
		(source.poolStateUpdatedAt ?? 0) >= (target.poolStateUpdatedAt ?? 0)
	) {
		target.poolState = source.poolState ? cloneJson(source.poolState) : undefined;
		target.poolStateUpdatedAt = source.poolStateUpdatedAt;
	}
	if (
		typeof source.telemetryUpdatedAt === "number" &&
		(source.telemetryUpdatedAt ?? 0) >= (target.telemetryUpdatedAt ?? 0)
	) {
		target.cascadeState = source.cascadeState ? cloneJson(source.cascadeState) : undefined;
		target.healthState = source.healthState ? cloneJson(source.healthState) : undefined;
		target.telemetryUpdatedAt = source.telemetryUpdatedAt;
	}
	target.pendingSelectionCount += source.pendingSelectionCount;
}

function hasPendingMutations(
	pendingState: PendingLightweightProviderState | undefined,
): pendingState is PendingLightweightProviderState {
	if (!pendingState) {
		return false;
	}

	return (
		Object.keys(pendingState.usageCountDeltas).length > 0 ||
		Object.keys(pendingState.lastUsedAt).length > 0 ||
		typeof pendingState.activeIndex === "number" ||
		pendingState.poolState !== undefined ||
		pendingState.cascadeState !== undefined ||
		pendingState.healthState !== undefined
	);
}

function applyPendingStateToProvider(
	providerState: ProviderRotationState,
	pendingState: PendingLightweightProviderState,
): boolean {
	reconcilePendingState(pendingState, providerState.credentialIds);
	let changed = false;

	for (const [credentialId, delta] of Object.entries(pendingState.usageCountDeltas)) {
		if (!Number.isFinite(delta) || delta <= 0) {
			continue;
		}
		const nextUsageCount = (providerState.usageCount[credentialId] ?? 0) + delta;
		if (providerState.usageCount[credentialId] !== nextUsageCount) {
			providerState.usageCount[credentialId] = nextUsageCount;
			changed = true;
		}
	}

	for (const [credentialId, lastUsedAt] of Object.entries(pendingState.lastUsedAt)) {
		if (!Number.isFinite(lastUsedAt) || lastUsedAt <= 0) {
			continue;
		}
		const nextLastUsedAt = Math.max(providerState.lastUsedAt[credentialId] ?? 0, lastUsedAt);
		if (providerState.lastUsedAt[credentialId] !== nextLastUsedAt) {
			providerState.lastUsedAt[credentialId] = nextLastUsedAt;
			changed = true;
		}
	}

	if (typeof pendingState.activeIndex === "number") {
		const nextActiveIndex =
			providerState.credentialIds.length === 0
				? 0
				: Math.max(0, Math.min(pendingState.activeIndex, providerState.credentialIds.length - 1));
		if (providerState.activeIndex !== nextActiveIndex) {
			providerState.activeIndex = nextActiveIndex;
			changed = true;
		}
	}

	if (
		pendingState.poolState !== undefined &&
		!haveSameJsonValue(providerState.poolState, pendingState.poolState)
	) {
		providerState.poolState = cloneJson(pendingState.poolState);
		changed = true;
	}

	if (
		pendingState.cascadeState !== undefined &&
		!haveSameJsonValue(providerState.cascadeState, pendingState.cascadeState)
	) {
		providerState.cascadeState = cloneJson(pendingState.cascadeState);
		changed = true;
	}

	if (
		pendingState.healthState !== undefined &&
		!haveSameJsonValue(providerState.healthState, pendingState.healthState)
	) {
		providerState.healthState = cloneJson(pendingState.healthState);
		changed = true;
	}

	return changed;
}

export class LightweightRotationState {
	private readonly flushIntervalMs: number;
	private readonly maxPendingSelections: number;
	private readonly pendingStateByProvider = new Map<SupportedProviderId, PendingLightweightProviderState>();
	private readonly flushTimerByProvider = new Map<SupportedProviderId, ReturnType<typeof setTimeout>>();
	private readonly flushPromiseByProvider = new Map<SupportedProviderId, Promise<void>>();
	private readonly flushRequestedWhileBusy = new Set<SupportedProviderId>();

	constructor(
		private readonly storage: MultiAuthStorage,
		options: LightweightRotationStateOptions = {},
	) {
		this.flushIntervalMs = normalizePositiveInteger(
			options.flushIntervalMs,
			DEFAULT_FLUSH_INTERVAL_MS,
		);
		this.maxPendingSelections = normalizePositiveInteger(
			options.maxPendingSelections,
			DEFAULT_MAX_PENDING_SELECTIONS,
		);
	}

	applyToProviderState(
		providerId: SupportedProviderId,
		providerState: ProviderRotationState,
	): ProviderRotationState {
		const pendingState = this.pendingStateByProvider.get(providerId);
		if (!hasPendingMutations(pendingState)) {
			return providerState;
		}
		applyPendingStateToProvider(providerState, pendingState);
		return providerState;
	}

	recordSelection(update: LightweightSelectionUpdate): void {
		const providerId = update.providerId.trim();
		const credentialId = update.credentialId.trim();
		if (!providerId) {
			throw new Error("Cannot record lightweight rotation selection: providerId is empty.");
		}
		if (!credentialId) {
			throw new Error("Cannot record lightweight rotation selection: credentialId is empty.");
		}
		if (!update.credentialIds.includes(credentialId)) {
			throw new Error(
				`Cannot record lightweight rotation selection for ${providerId}: credential '${credentialId}' is not part of the provider credential set.`,
			);
		}

		const pendingState = this.getOrCreatePendingState(providerId, update.credentialIds);
		const selectedAt = Number.isFinite(update.selectedAt) && update.selectedAt > 0
			? update.selectedAt
			: Date.now();
		if (update.incrementUsage !== false) {
			pendingState.usageCountDeltas[credentialId] =
				(pendingState.usageCountDeltas[credentialId] ?? 0) + 1;
		}
		pendingState.lastUsedAt[credentialId] = Math.max(
			pendingState.lastUsedAt[credentialId] ?? 0,
			selectedAt,
		);
		pendingState.activeIndex = update.nextActiveIndex;
		pendingState.activeIndexUpdatedAt = selectedAt;
		if (update.poolState !== undefined) {
			pendingState.poolState = cloneJson(update.poolState);
			pendingState.poolStateUpdatedAt = selectedAt;
		}
		pendingState.pendingSelectionCount += 1;
		this.scheduleFlush(providerId, pendingState);
	}

	recordTelemetry(update: LightweightTelemetryUpdate): void {
		const providerId = update.providerId.trim();
		if (!providerId) {
			throw new Error("Cannot record lightweight rotation telemetry: providerId is empty.");
		}

		const pendingState = this.getOrCreatePendingState(providerId, update.credentialIds);
		pendingState.cascadeState = update.cascadeState ? cloneJson(update.cascadeState) : undefined;
		pendingState.healthState = update.healthState ? cloneJson(update.healthState) : undefined;
		pendingState.telemetryUpdatedAt = Date.now();
		this.scheduleFlush(providerId, pendingState);
	}

	async flushProvider(providerId: SupportedProviderId): Promise<void> {
		const normalizedProviderId = providerId.trim();
		if (!normalizedProviderId) {
			throw new Error("Cannot flush lightweight rotation state: providerId is empty.");
		}

		const existingFlush = this.flushPromiseByProvider.get(normalizedProviderId);
		if (existingFlush) {
			this.flushRequestedWhileBusy.add(normalizedProviderId);
			await existingFlush;
			return;
		}

		this.clearScheduledFlush(normalizedProviderId);
		const flushPromise = this.performFlush(normalizedProviderId).finally(async () => {
			if (this.flushPromiseByProvider.get(normalizedProviderId) === flushPromise) {
				this.flushPromiseByProvider.delete(normalizedProviderId);
			}
			if (this.flushRequestedWhileBusy.delete(normalizedProviderId)) {
				await this.flushProvider(normalizedProviderId);
			}
		});
		this.flushPromiseByProvider.set(normalizedProviderId, flushPromise);
		await flushPromise;
	}

	async flushAll(): Promise<void> {
		for (const providerId of [...this.pendingStateByProvider.keys()]) {
			await this.flushProvider(providerId);
		}
	}

	shutdown(): void {
		for (const timer of this.flushTimerByProvider.values()) {
			clearTimeout(timer);
		}
		this.flushTimerByProvider.clear();
	}

	private getOrCreatePendingState(
		providerId: SupportedProviderId,
		credentialIds: readonly string[],
	): PendingLightweightProviderState {
		const existing = this.pendingStateByProvider.get(providerId);
		if (existing) {
			reconcilePendingState(existing, credentialIds);
			return existing;
		}

		const created = createPendingState(credentialIds);
		this.pendingStateByProvider.set(providerId, created);
		return created;
	}

	private scheduleFlush(
		providerId: SupportedProviderId,
		pendingState: PendingLightweightProviderState,
	): void {
		if (pendingState.pendingSelectionCount >= this.maxPendingSelections) {
			void this.runBackgroundFlush(providerId);
			return;
		}
		if (this.flushTimerByProvider.has(providerId)) {
			return;
		}

		const flushTimer = setTimeout(() => {
			this.flushTimerByProvider.delete(providerId);
			void this.runBackgroundFlush(providerId);
		}, this.flushIntervalMs);
		this.flushTimerByProvider.set(providerId, flushTimer);
	}

	private clearScheduledFlush(providerId: SupportedProviderId): void {
		const flushTimer = this.flushTimerByProvider.get(providerId);
		if (!flushTimer) {
			return;
		}
		clearTimeout(flushTimer);
		this.flushTimerByProvider.delete(providerId);
	}

	private async runBackgroundFlush(providerId: SupportedProviderId): Promise<void> {
		try {
			await this.flushProvider(providerId);
		} catch (error) {
			multiAuthDebugLogger.log("lightweight_rotation_flush_failed", {
				providerId,
				error: error instanceof Error ? error.message : String(error),
			});
			const pendingState = this.pendingStateByProvider.get(providerId);
			if (hasPendingMutations(pendingState)) {
				this.scheduleFlush(providerId, pendingState);
			}
		}
	}

	private async performFlush(providerId: SupportedProviderId): Promise<void> {
		const pendingState = this.pendingStateByProvider.get(providerId);
		if (!hasPendingMutations(pendingState)) {
			this.pendingStateByProvider.delete(providerId);
			return;
		}

		this.pendingStateByProvider.delete(providerId);
		try {
			await this.storage.withLock((state) => {
				const providerState = getProviderState(state, providerId);
				const didChange = applyPendingStateToProvider(providerState, pendingState);
				return didChange ? { result: undefined, next: state } : { result: undefined };
			});
		} catch (error) {
			const currentPendingState = this.pendingStateByProvider.get(providerId);
			if (currentPendingState) {
				mergePendingState(currentPendingState, pendingState);
			} else {
				this.pendingStateByProvider.set(providerId, pendingState);
			}
			throw error;
		}
	}
}
