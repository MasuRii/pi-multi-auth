export type UsageCoordinationOperation =
	| "direct"
	| "selection"
	| "blocked-reconciliation"
	| "entitlement"
	| "startup-refinement"
	| "modal-refresh"
	| "manual-account-refresh"
	| "manual-provider-refresh";

export interface UsageCoordinationConfig {
	enabled: boolean;
	globalMaxConcurrentFreshRequests: number;
	perProviderMaxConcurrentFreshRequests: number;
	selectionCandidateWindow: number;
	blockedReconciliationCandidateWindow: number;
	entitlementCandidateWindow: number;
	startupCandidateWindow: number;
	modalRefreshCandidateWindow: number;
	manualProviderRefreshCandidateWindow: number;
	accountCooldownMs: number;
	providerCooldownMs: number;
	circuitBreakerFailureThreshold: number;
	circuitBreakerCooldownMs: number;
	jitterMs: number;
}

export const DEFAULT_USAGE_COORDINATION_CONFIG: UsageCoordinationConfig = {
	enabled: true,
	globalMaxConcurrentFreshRequests: 4,
	perProviderMaxConcurrentFreshRequests: 2,
	selectionCandidateWindow: 8,
	blockedReconciliationCandidateWindow: 6,
	entitlementCandidateWindow: 10,
	startupCandidateWindow: 6,
	modalRefreshCandidateWindow: 8,
	manualProviderRefreshCandidateWindow: 10,
	accountCooldownMs: 30_000,
	providerCooldownMs: 60_000,
	circuitBreakerFailureThreshold: 3,
	circuitBreakerCooldownMs: 120_000,
	jitterMs: 2_000,
};

export interface UsageRequestDescriptor {
	provider: string;
	credentialId: string;
	operation: UsageCoordinationOperation;
}

export type UsageRequestDeferralReason = "credential_cooldown";

interface UsageRequestDeferral {
	reason: UsageRequestDeferralReason;
	retryAt: number;
	message: string;
}

export class UsageRequestDeferredError extends Error {
	readonly provider: string;
	readonly credentialId: string;
	readonly reason: UsageRequestDeferralReason;
	readonly retryAt: number;

	constructor(descriptor: UsageRequestDescriptor, deferral: UsageRequestDeferral) {
		super(deferral.message);
		this.name = "UsageRequestDeferredError";
		this.provider = descriptor.provider;
		this.credentialId = descriptor.credentialId;
		this.reason = deferral.reason;
		this.retryAt = deferral.retryAt;
	}
}

export function isUsageRequestDeferredError(error: unknown): error is UsageRequestDeferredError {
	return error instanceof UsageRequestDeferredError;
}

export function formatUsageRequestDeferredNote(error: UsageRequestDeferredError): string {
	const retrySuffix = error.retryAt > Date.now()
		? ` until ${new Date(error.retryAt).toISOString()}`
		: "";
	return `Live usage refresh deferred${retrySuffix}; showing last-known usage when available.`;
}

interface QueueEntry {
	descriptor: UsageRequestDescriptor;
	run: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

interface ProviderPolicyState {
	inFlight: number;
}

const PROGRESSIVE_WINDOW_OPERATIONS = new Set<UsageCoordinationOperation>([
	"modal-refresh",
]);
const ROTATING_WINDOW_OPERATIONS = new Set<UsageCoordinationOperation>([
	"selection",
	"blocked-reconciliation",
	"entitlement",
	"startup-refinement",
	"modal-refresh",
	"manual-provider-refresh",
]);

function cloneUsageCoordinationConfig(
	config: UsageCoordinationConfig = DEFAULT_USAGE_COORDINATION_CONFIG,
): UsageCoordinationConfig {
	return { ...config };
}

function isFinitePositiveInteger(value: number): boolean {
	return Number.isInteger(value) && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegativeInteger(value: number): boolean {
	return Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

function redactIdentifier(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `id:${hash.toString(16).padStart(8, "0")}`;
}

function getOperationWindow(
	config: UsageCoordinationConfig,
	operation: UsageCoordinationOperation,
): number {
	switch (operation) {
		case "selection":
			return config.selectionCandidateWindow;
		case "blocked-reconciliation":
			return config.blockedReconciliationCandidateWindow;
		case "entitlement":
			return config.entitlementCandidateWindow;
		case "startup-refinement":
			return config.startupCandidateWindow;
		case "modal-refresh":
			return config.modalRefreshCandidateWindow;
		case "manual-provider-refresh":
			return config.manualProviderRefreshCandidateWindow;
		case "manual-account-refresh":
		case "direct":
			return 1;
	}
}

export function redactUsageCredentialIdentifier(value: string): string {
	return redactIdentifier(value.trim());
}

export function summarizeUsageCredentialInventory(credentialIds: readonly string[]): {
	count: number;
	sample: string[];
} {
	return {
		count: credentialIds.length,
		sample: credentialIds.slice(0, 3).map(redactUsageCredentialIdentifier),
	};
}

/**
 * Central admission controller for fresh usage API calls.
 * It keeps cache reads outside policy enforcement while bounding fresh provider calls globally,
 * per provider, and per high-cardinality operation window.
 */
export class UsageCoordinator {
	private config: UsageCoordinationConfig;
	private globalInFlight = 0;
	private readonly providerState = new Map<string, ProviderPolicyState>();
	private readonly accountCooldownUntil = new Map<string, number>();
	private readonly queue: QueueEntry[] = [];
	private readonly progressiveWindowCursors = new Map<string, number>();

	constructor(config: UsageCoordinationConfig = DEFAULT_USAGE_COORDINATION_CONFIG) {
		this.config = cloneUsageCoordinationConfig(config);
		this.validateConfig(this.config);
	}

	updateConfig(config: UsageCoordinationConfig): void {
		const nextConfig = cloneUsageCoordinationConfig(config);
		this.validateConfig(nextConfig);
		this.config = nextConfig;
		this.drainQueue();
	}

	selectCredentialIds(
		credentialIds: readonly string[],
		operation: UsageCoordinationOperation,
	): string[] {
		const uniqueCredentialIds = [...new Set(credentialIds.map((entry) => entry.trim()).filter(Boolean))];
		return this.selectBoundedWindow(uniqueCredentialIds, operation, "credential-ids");
	}

	selectCredentialIdWindows(
		credentialIds: readonly string[],
		operation: UsageCoordinationOperation,
	): string[][] {
		const uniqueCredentialIds = [...new Set(credentialIds.map((entry) => entry.trim()).filter(Boolean))];
		return this.partitionBoundedWindows(uniqueCredentialIds, operation, "credential-ids");
	}

	selectCredentialRequests<TRequest extends { provider: string; credentialId: string }>(
		requests: readonly TRequest[],
		operation: UsageCoordinationOperation,
	): TRequest[] {
		const seen = new Set<string>();
		const uniqueRequests: TRequest[] = [];
		for (const request of requests) {
			const provider = request.provider.trim();
			const credentialId = request.credentialId.trim();
			if (!provider || !credentialId) {
				continue;
			}
			const key = this.credentialRequestKey(provider, credentialId);
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			uniqueRequests.push(request);
		}
		return this.selectBoundedWindow(uniqueRequests, operation, "credential-requests");
	}

	selectCredentialRequestWindows<TRequest extends { provider: string; credentialId: string }>(
		requests: readonly TRequest[],
		operation: UsageCoordinationOperation,
	): TRequest[][] {
		return this.partitionBoundedWindows(
			this.deduplicateCredentialRequests(requests),
			operation,
			"credential-requests",
		);
	}

	getOperationWindowSize(operation: UsageCoordinationOperation): number {
		return Math.max(1, getOperationWindow(this.config, operation));
	}

	private deduplicateCredentialRequests<TRequest extends { provider: string; credentialId: string }>(
		requests: readonly TRequest[],
	): TRequest[] {
		const seen = new Set<string>();
		const uniqueRequests: TRequest[] = [];
		for (const request of requests) {
			const provider = request.provider.trim();
			const credentialId = request.credentialId.trim();
			if (!provider || !credentialId) {
				continue;
			}
			const key = this.credentialRequestKey(provider, credentialId);
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			uniqueRequests.push(request);
		}
		return uniqueRequests;
	}

	private selectBoundedWindow<TValue>(
		candidates: readonly TValue[],
		operation: UsageCoordinationOperation,
		cursorScope: string,
	): TValue[] {
		const windowSize = Math.max(1, getOperationWindow(this.config, operation));
		if (candidates.length <= windowSize) {
			this.progressiveWindowCursors.delete(this.progressiveWindowCursorKey(operation, cursorScope));
			return [...candidates];
		}

		if (!PROGRESSIVE_WINDOW_OPERATIONS.has(operation)) {
			return candidates.slice(0, windowSize);
		}

		const cursorKey = this.progressiveWindowCursorKey(operation, cursorScope);
		const startIndex = (this.progressiveWindowCursors.get(cursorKey) ?? 0) % candidates.length;
		const selected: TValue[] = [];
		for (let offset = 0; offset < windowSize; offset += 1) {
			selected.push(candidates[(startIndex + offset) % candidates.length]);
		}
		this.progressiveWindowCursors.set(cursorKey, (startIndex + selected.length) % candidates.length);
		return selected;
	}

	private partitionBoundedWindows<TValue>(
		candidates: readonly TValue[],
		operation: UsageCoordinationOperation,
		cursorScope: string,
	): TValue[][] {
		if (candidates.length === 0) {
			this.progressiveWindowCursors.delete(this.progressiveWindowCursorKey(operation, cursorScope));
			return [];
		}

		const windowSize = this.getOperationWindowSize(operation);
		if (candidates.length <= windowSize) {
			this.progressiveWindowCursors.delete(this.progressiveWindowCursorKey(operation, cursorScope));
			return [[...candidates]];
		}

		const rotated = this.rotateCandidates(candidates, operation, cursorScope);
		const windows: TValue[][] = [];
		for (let index = 0; index < rotated.length; index += windowSize) {
			windows.push(rotated.slice(index, index + windowSize));
		}
		return windows;
	}

	private rotateCandidates<TValue>(
		candidates: readonly TValue[],
		operation: UsageCoordinationOperation,
		cursorScope: string,
	): TValue[] {
		if (!ROTATING_WINDOW_OPERATIONS.has(operation) || candidates.length === 0) {
			return [...candidates];
		}

		const cursorKey = this.progressiveWindowCursorKey(operation, cursorScope);
		const windowSize = this.getOperationWindowSize(operation);
		const startIndex = (this.progressiveWindowCursors.get(cursorKey) ?? 0) % candidates.length;
		const rotated = [...candidates.slice(startIndex), ...candidates.slice(0, startIndex)];
		this.progressiveWindowCursors.set(cursorKey, (startIndex + windowSize) % candidates.length);
		return rotated;
	}

	private progressiveWindowCursorKey(
		operation: UsageCoordinationOperation,
		cursorScope: string,
	): string {
		return `${operation}:${cursorScope}`;
	}

	private credentialRequestKey(provider: string, credentialId: string): string {
		return `${provider.length}:${provider}${credentialId.length}:${credentialId}`;
	}

	async executeFreshRequest<T>(
		descriptor: UsageRequestDescriptor,
		run: () => Promise<T>,
	): Promise<T> {
		this.assertValidDescriptor(descriptor);
		if (!this.config.enabled) {
			return run();
		}

		this.assertRequestPolicyAllows(descriptor);
		return new Promise<T>((resolve, reject) => {
			this.queue.push({
				descriptor,
				run,
				resolve: (value: unknown) => resolve(value as T),
				reject,
			});
			this.drainQueue();
		});
	}

	getRedactedDebugState(): Record<string, unknown> {
		return {
			globalInFlight: this.globalInFlight,
			queued: this.queue.length,
			providers: [...this.providerState.entries()].map(([provider, state]) => ({
				provider,
				inFlight: state.inFlight,
			})),
			credentialCooldowns: this.getRedactedCredentialCooldowns(Date.now()),
		};
	}

	private validateConfig(config: UsageCoordinationConfig): void {
		const positiveFields: Array<keyof UsageCoordinationConfig> = [
			"globalMaxConcurrentFreshRequests",
			"perProviderMaxConcurrentFreshRequests",
			"selectionCandidateWindow",
			"blockedReconciliationCandidateWindow",
			"entitlementCandidateWindow",
			"startupCandidateWindow",
			"modalRefreshCandidateWindow",
			"manualProviderRefreshCandidateWindow",
			"circuitBreakerFailureThreshold",
		];
		for (const field of positiveFields) {
			const value = config[field];
			if (typeof value !== "number" || !isFinitePositiveInteger(value)) {
				throw new Error(`Invalid usage coordination config '${field}': expected a positive integer.`);
			}
		}

		const nonNegativeFields: Array<keyof UsageCoordinationConfig> = [
			"accountCooldownMs",
			"providerCooldownMs",
			"circuitBreakerCooldownMs",
			"jitterMs",
		];
		for (const field of nonNegativeFields) {
			const value = config[field];
			if (typeof value !== "number" || !isFiniteNonNegativeInteger(value)) {
				throw new Error(`Invalid usage coordination config '${field}': expected a non-negative integer.`);
			}
		}
	}

	private assertValidDescriptor(descriptor: UsageRequestDescriptor): void {
		if (!descriptor.provider.trim()) {
			throw new Error("Usage request provider must be a non-empty string.");
		}
		if (!descriptor.credentialId.trim()) {
			throw new Error("Usage request credential ID must be a non-empty string.");
		}
	}

	private assertRequestPolicyAllows(descriptor: UsageRequestDescriptor): void {
		const deferral = this.resolveRequestDeferral(descriptor, Date.now());
		if (deferral) {
			throw new UsageRequestDeferredError(descriptor, deferral);
		}
	}

	private resolveRequestDeferral(
		descriptor: UsageRequestDescriptor,
		now: number,
	): UsageRequestDeferral | null {
		const accountCooldown = this.accountCooldownUntil.get(
			this.accountKey(descriptor.provider, descriptor.credentialId),
		) ?? 0;
		if (accountCooldown > now) {
			return {
				reason: "credential_cooldown",
				retryAt: accountCooldown,
				message: `Fresh usage request deferred for ${descriptor.provider}: credential usage cooldown is active until ${new Date(accountCooldown).toISOString()}.`,
			};
		}
		return null;
	}

	private drainQueue(): void {
		if (!this.config.enabled) {
			this.drainWithoutBudgets();
			return;
		}

		let progressed = true;
		while (progressed) {
			progressed = false;
			for (let index = 0; index < this.queue.length; index += 1) {
				const entry = this.queue[index];
				if (!entry || !this.hasCapacity(entry.descriptor.provider)) {
					continue;
				}
				this.queue.splice(index, 1);
				if (!this.dispatchPolicyAllows(entry)) {
					progressed = true;
					break;
				}
				this.startEntry(entry);
				progressed = true;
				break;
			}
		}
	}

	private dispatchPolicyAllows(entry: QueueEntry): boolean {
		try {
			this.assertRequestPolicyAllows(entry.descriptor);
			return true;
		} catch (error: unknown) {
			entry.reject(error);
			return false;
		}
	}

	private drainWithoutBudgets(): void {
		while (this.queue.length > 0) {
			const entry = this.queue.shift();
			if (entry) {
				this.startEntry(entry);
			}
		}
	}

	private hasCapacity(provider: string): boolean {
		const providerState = this.getProviderState(provider);
		return (
			this.globalInFlight < this.config.globalMaxConcurrentFreshRequests &&
			providerState.inFlight < this.config.perProviderMaxConcurrentFreshRequests
		);
	}

	private startEntry(entry: QueueEntry): void {
		const providerState = this.getProviderState(entry.descriptor.provider);
		this.globalInFlight += 1;
		providerState.inFlight += 1;

		entry.run()
			.then((value) => {
				this.recordSuccess(entry.descriptor.provider);
				entry.resolve(value);
			})
			.catch((error: unknown) => {
				this.recordFailure(entry.descriptor, error);
				entry.reject(error);
			})
			.finally(() => {
				this.globalInFlight = Math.max(0, this.globalInFlight - 1);
				providerState.inFlight = Math.max(0, providerState.inFlight - 1);
				this.drainQueue();
			});
	}

	private recordSuccess(_provider: string): void {
		// Usage lookups are advisory; successful metadata refreshes do not need provider-level recovery state.
	}

	private recordFailure(descriptor: UsageRequestDescriptor, _error: unknown): void {
		const now = Date.now();
		const jitter = this.resolveJitterMs(descriptor.provider, descriptor.credentialId);
		const accountCooldownMs = this.config.accountCooldownMs + jitter;
		if (accountCooldownMs <= 0) {
			this.accountCooldownUntil.delete(this.accountKey(descriptor.provider, descriptor.credentialId));
			return;
		}
		this.accountCooldownUntil.set(
			this.accountKey(descriptor.provider, descriptor.credentialId),
			now + accountCooldownMs,
		);
	}

	private getProviderState(provider: string): ProviderPolicyState {
		const existing = this.providerState.get(provider);
		if (existing) {
			return existing;
		}
		const created: ProviderPolicyState = {
			inFlight: 0,
		};
		this.providerState.set(provider, created);
		return created;
	}

	private getRedactedCredentialCooldowns(now: number): Array<{
		provider: string;
		credentialRef: string;
		retryAt: number;
	}> {
		const cooldowns: Array<{ provider: string; credentialRef: string; retryAt: number }> = [];
		for (const [key, retryAt] of this.accountCooldownUntil.entries()) {
			if (retryAt <= now) {
				continue;
			}
			const separatorIndex = key.indexOf("\u0000");
			const provider = separatorIndex >= 0 ? key.slice(0, separatorIndex) : "unknown";
			const credentialId = separatorIndex >= 0 ? key.slice(separatorIndex + 1) : key;
			cooldowns.push({
				provider,
				credentialRef: redactIdentifier(credentialId),
				retryAt,
			});
		}
		return cooldowns;
	}

	private resolveJitterMs(provider: string, credentialId: string): number {
		if (this.config.jitterMs <= 0) {
			return 0;
		}
		let hash = 0;
		const value = `${provider}:${credentialId}`;
		for (let index = 0; index < value.length; index += 1) {
			hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
		}
		return hash % (this.config.jitterMs + 1);
	}

	private accountKey(provider: string, credentialId: string): string {
		return `${provider}\u0000${credentialId}`;
	}
}
