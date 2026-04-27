import { constants as fsConstants } from "node:fs";
import { access, chmod, readFile, stat, writeFile } from "node:fs/promises";
import {
	DEBUG_DIR,
	cloneHistoryPersistenceConfig,
	ensureMultiAuthDebugDirectory,
	resolveStateHistoryPersistencePaths,
	type HistoryPersistenceConfig,
} from "./config.js";
import { getErrorMessage } from "./auth-error-utils.js";
import {
	isRetryableFileAccessError,
	readTextSnapshotWithRetries,
	writeTextSnapshotWithRetries,
} from "./file-retry.js";
import { cloneJson } from "./json-utils.js";
import { redactUsageCredentialIdentifier } from "./usage/usage-coordinator.js";
import type { CascadeRetryState } from "./types-cascade.js";
import type { MultiAuthState, ProviderRotationState } from "./types.js";
import type { HealthMetricsHistory } from "./types-health.js";

const HISTORY_SNAPSHOT_VERSION = 1;

type HealthHistorySnapshot = {
	version: typeof HISTORY_SNAPSHOT_VERSION;
	providers: Record<string, Record<string, HealthMetricsHistory>>;
};

type CascadeHistorySnapshot = {
	version: typeof HISTORY_SNAPSHOT_VERSION;
	providers: Record<string, Record<string, CascadeRetryState[]>>;
};

export interface MultiAuthHistoryStoreOptions {
	debugDir?: string;
	historyPersistence?: HistoryPersistenceConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createEmptyHealthHistorySnapshot(): HealthHistorySnapshot {
	return {
		version: HISTORY_SNAPSHOT_VERSION,
		providers: {},
	};
}

function createEmptyCascadeHistorySnapshot(): CascadeHistorySnapshot {
	return {
		version: HISTORY_SNAPSHOT_VERSION,
		providers: {},
	};
}

function resolveCredentialReference(
	state: MultiAuthState,
	providerId: string,
	credentialReference: string,
): string {
	const trimmedReference = credentialReference.trim();
	if (!trimmedReference) {
		return credentialReference;
	}

	const providerState = state.providers[providerId];
	if (!providerState) {
		return trimmedReference;
	}

	if (providerState.credentialIds.includes(trimmedReference)) {
		return trimmedReference;
	}

	for (const credentialId of providerState.credentialIds) {
		if (redactUsageCredentialIdentifier(credentialId) === trimmedReference) {
			return credentialId;
		}
	}

	return trimmedReference;
}

function createRedactedHealthHistoryEntry(
	credentialId: string,
	history: HealthMetricsHistory,
): [string, HealthMetricsHistory] {
	const redactedCredentialId = redactUsageCredentialIdentifier(credentialId);
	return [
		redactedCredentialId,
		cloneJson({
			...history,
			credentialId: redactedCredentialId,
		}) as HealthMetricsHistory,
	];
}

function createHydratedHealthHistoryEntry(
	state: MultiAuthState,
	providerId: string,
	credentialReference: string,
	history: HealthMetricsHistory,
): [string, HealthMetricsHistory] {
	const sourceCredentialId =
		typeof history.credentialId === "string" && history.credentialId.trim().length > 0
			? history.credentialId
			: credentialReference;
	const resolvedFromKey = resolveCredentialReference(state, providerId, credentialReference);
	const resolvedCredentialId =
		resolvedFromKey !== credentialReference.trim()
			? resolvedFromKey
			: resolveCredentialReference(state, providerId, sourceCredentialId);

	return [
		resolvedCredentialId,
		cloneJson({
			...history,
			credentialId: resolvedCredentialId,
		}) as HealthMetricsHistory,
	];
}

function redactCascadeHistory(history: readonly CascadeRetryState[]): CascadeRetryState[] {
	return history.map((entry) => ({
		...cloneJson(entry),
		cascadePath: entry.cascadePath.map((attempt) => ({
			...attempt,
			credentialId: redactUsageCredentialIdentifier(attempt.credentialId),
		})),
	})) as CascadeRetryState[];
}

function hydrateCascadeHistory(
	state: MultiAuthState,
	history: readonly CascadeRetryState[],
): CascadeRetryState[] {
	return history.map((entry) => ({
		...cloneJson(entry),
		cascadePath: entry.cascadePath.map((attempt) => ({
			...attempt,
			credentialId: resolveCredentialReference(state, attempt.providerId, attempt.credentialId),
		})),
	})) as CascadeRetryState[];
}

function parseHealthHistorySnapshot(content: string | undefined): HealthHistorySnapshot {
	if (!content || content.trim() === "") {
		return createEmptyHealthHistorySnapshot();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(
			`Invalid JSON in extracted health history snapshot: ${getErrorMessage(error)}`,
		);
	}

	if (!isRecord(parsed)) {
		return createEmptyHealthHistorySnapshot();
	}

	const providersRaw = isRecord(parsed.providers) ? parsed.providers : {};
	const providers: HealthHistorySnapshot["providers"] = {};
	for (const [providerId, providerHistoryRaw] of Object.entries(providersRaw)) {
		if (!isRecord(providerHistoryRaw)) {
			continue;
		}

		const providerHistory: Record<string, HealthMetricsHistory> = {};
		for (const [credentialId, historyRaw] of Object.entries(providerHistoryRaw)) {
			if (!isRecord(historyRaw)) {
				continue;
			}

			providerHistory[credentialId] = cloneJson({
				credentialId:
					typeof historyRaw.credentialId === "string" && historyRaw.credentialId.trim().length > 0
						? historyRaw.credentialId.trim()
						: credentialId,
				requests: Array.isArray(historyRaw.requests) ? historyRaw.requests : [],
				cooldowns: Array.isArray(historyRaw.cooldowns) ? historyRaw.cooldowns : [],
				lastScore:
					typeof historyRaw.lastScore === "number" && Number.isFinite(historyRaw.lastScore)
						? historyRaw.lastScore
						: 0,
				lastCalculatedAt:
					typeof historyRaw.lastCalculatedAt === "number" &&
					Number.isFinite(historyRaw.lastCalculatedAt)
						? historyRaw.lastCalculatedAt
						: 0,
			}) as HealthMetricsHistory;
		}

		if (Object.keys(providerHistory).length > 0) {
			providers[providerId] = providerHistory;
		}
	}

	return {
		version: HISTORY_SNAPSHOT_VERSION,
		providers,
	};
}

function parseCascadeHistorySnapshot(content: string | undefined): CascadeHistorySnapshot {
	if (!content || content.trim() === "") {
		return createEmptyCascadeHistorySnapshot();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(
			`Invalid JSON in extracted cascade history snapshot: ${getErrorMessage(error)}`,
		);
	}

	if (!isRecord(parsed)) {
		return createEmptyCascadeHistorySnapshot();
	}

	const providersRaw = isRecord(parsed.providers) ? parsed.providers : {};
	const providers: CascadeHistorySnapshot["providers"] = {};
	for (const [providerId, providerHistoryRaw] of Object.entries(providersRaw)) {
		if (!isRecord(providerHistoryRaw)) {
			continue;
		}

		const providerHistory: Record<string, CascadeRetryState[]> = {};
		for (const [cascadeProviderId, historyRaw] of Object.entries(providerHistoryRaw)) {
			if (!Array.isArray(historyRaw)) {
				continue;
			}
			providerHistory[cascadeProviderId] = cloneJson(historyRaw) as CascadeRetryState[];
		}

		if (Object.keys(providerHistory).length > 0) {
			providers[providerId] = providerHistory;
		}
	}

	return {
		version: HISTORY_SNAPSHOT_VERSION,
		providers,
	};
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function buildFileFingerprint(filePath: string): Promise<string> {
	try {
		const fileStats = await stat(filePath);
		return `${Math.round(fileStats.mtimeMs)}:${fileStats.size}`;
	} catch (error) {
		const maybeCode = (error as Error & { code?: unknown }).code;
		if (maybeCode === "ENOENT") {
			return "missing";
		}
		throw error instanceof Error ? error : new Error(String(error));
	}
}

async function readHistorySnapshot<T>(
	filePath: string,
	failureLabel: string,
	invalidJsonPrefix: string,
	parse: (content: string | undefined) => T,
	emptySnapshot: () => T,
): Promise<T> {
	return readTextSnapshotWithRetries({
		filePath,
		failureMessage: `Failed to read ${failureLabel} from '${filePath}'.`,
		read: async () => ((await pathExists(filePath)) ? readFile(filePath, "utf-8") : undefined),
		parse,
		resolveOnFinalEmpty: emptySnapshot,
		isRetryableError: (error) =>
			error.message.startsWith(invalidJsonPrefix) || isRetryableFileAccessError(error),
	});
}

async function writeHistorySnapshot(
	filePath: string,
	serializedSnapshot: string,
	debugDir: string,
	failureLabel: string,
): Promise<void> {
	await writeTextSnapshotWithRetries({
		filePath,
		failureMessage: `Failed to persist ${failureLabel} to '${filePath}'.`,
		write: async () => {
			const debugDirectoryWarning = ensureMultiAuthDebugDirectory(debugDir);
			if (debugDirectoryWarning) {
				throw new Error(debugDirectoryWarning);
			}
			await writeFile(filePath, serializedSnapshot, "utf-8");
			await chmod(filePath, 0o600);
		},
		isRetryableError: isRetryableFileAccessError,
	});
}

function extractHealthHistory(state: MultiAuthState): HealthHistorySnapshot {
	const providers: HealthHistorySnapshot["providers"] = {};
	for (const [providerId, providerState] of Object.entries(state.providers)) {
		const history = providerState.healthState?.history;
		if (!history || Object.keys(history).length === 0) {
			continue;
		}

		const providerHistory: Record<string, HealthMetricsHistory> = {};
		for (const [credentialId, historyEntry] of Object.entries(history)) {
			const [redactedCredentialId, redactedHistoryEntry] = createRedactedHealthHistoryEntry(
				credentialId,
				historyEntry,
			);
			providerHistory[redactedCredentialId] = redactedHistoryEntry;
		}

		if (Object.keys(providerHistory).length > 0) {
			providers[providerId] = providerHistory;
		}
	}

	return {
		version: HISTORY_SNAPSHOT_VERSION,
		providers,
	};
}

function extractCascadeHistory(state: MultiAuthState): CascadeHistorySnapshot {
	const providers: CascadeHistorySnapshot["providers"] = {};
	for (const [providerId, providerState] of Object.entries(state.providers)) {
		if (!providerState.cascadeState) {
			continue;
		}

		const providerHistory: Record<string, CascadeRetryState[]> = {};
		for (const [cascadeProviderId, cascadeState] of Object.entries(providerState.cascadeState)) {
			if (!cascadeState || cascadeState.history.length === 0) {
				continue;
			}
			providerHistory[cascadeProviderId] = redactCascadeHistory(cascadeState.history);
		}

		if (Object.keys(providerHistory).length > 0) {
			providers[providerId] = providerHistory;
		}
	}

	return {
		version: HISTORY_SNAPSHOT_VERSION,
		providers,
	};
}

function stripHealthHistory(state: MultiAuthState): void {
	for (const providerState of Object.values(state.providers)) {
		if (!providerState.healthState) {
			continue;
		}

		delete providerState.healthState.history;
		if (
			Object.keys(providerState.healthState.scores ?? {}).length === 0 &&
			providerState.healthState.configHash === undefined
		) {
			providerState.healthState = undefined;
		}
	}
}

function stripCascadeHistory(state: MultiAuthState): void {
	for (const providerState of Object.values(state.providers)) {
		if (!providerState.cascadeState) {
			continue;
		}

		for (const [cascadeProviderId, cascadeState] of Object.entries(providerState.cascadeState)) {
			if (!cascadeState) {
				delete providerState.cascadeState[cascadeProviderId];
				continue;
			}

			if (cascadeState.active) {
				cascadeState.history = [];
				continue;
			}

			delete providerState.cascadeState[cascadeProviderId];
		}

		if (Object.keys(providerState.cascadeState).length === 0) {
			providerState.cascadeState = undefined;
		}
	}
}

function mergeExtractedHealthHistory(state: MultiAuthState, snapshot: HealthHistorySnapshot): void {
	for (const [providerId, extractedHistory] of Object.entries(snapshot.providers)) {
		const providerState = state.providers[providerId];
		if (!providerState) {
			continue;
		}

		const embeddedHistory = providerState.healthState?.history;
		const hydratedExtractedHistory: Record<string, HealthMetricsHistory> = {};
		for (const [credentialReference, historyEntry] of Object.entries(extractedHistory)) {
			const [credentialId, hydratedHistoryEntry] = createHydratedHealthHistoryEntry(
				state,
				providerId,
				credentialReference,
				historyEntry,
			);
			hydratedExtractedHistory[credentialId] = hydratedHistoryEntry;
		}

		const mergedHistory = {
			...hydratedExtractedHistory,
			...(embeddedHistory ? (cloneJson(embeddedHistory) as Record<string, HealthMetricsHistory>) : {}),
		};
		if (Object.keys(mergedHistory).length === 0) {
			continue;
		}

		providerState.healthState = {
			scores: providerState.healthState?.scores ? cloneJson(providerState.healthState.scores) : {},
			history: mergedHistory,
			configHash: providerState.healthState?.configHash,
		};
	}
}

function mergeExtractedCascadeHistory(state: MultiAuthState, snapshot: CascadeHistorySnapshot): void {
	for (const [providerId, extractedProviderHistory] of Object.entries(snapshot.providers)) {
		const providerState = state.providers[providerId];
		if (!providerState) {
			continue;
		}

		providerState.cascadeState = providerState.cascadeState ?? {};
		for (const [cascadeProviderId, extractedHistory] of Object.entries(extractedProviderHistory)) {
			const currentState = providerState.cascadeState[cascadeProviderId];
			const currentHistory = currentState?.history;
			providerState.cascadeState[cascadeProviderId] = {
				active: currentState?.active ? cloneJson(currentState.active) : undefined,
				history:
					currentHistory && currentHistory.length > 0
						? (cloneJson(currentHistory) as CascadeRetryState[])
						: hydrateCascadeHistory(state, extractedHistory),
			};
		}

		if (Object.keys(providerState.cascadeState).length === 0) {
			providerState.cascadeState = undefined;
		}
	}
}

export class MultiAuthHistoryStore {
	private readonly debugDir: string;
	private readonly historyPersistence: HistoryPersistenceConfig;

	constructor(options: MultiAuthHistoryStoreOptions = {}) {
		this.debugDir = options.debugDir ?? DEBUG_DIR;
		this.historyPersistence = cloneHistoryPersistenceConfig(options.historyPersistence);
	}

	isEnabled(): boolean {
		return this.historyPersistence.enabled;
	}

	getDebugDir(): string {
		return this.debugDir;
	}

	async createFingerprint(): Promise<string> {
		if (!this.isEnabled()) {
			return "";
		}

		const { healthPath, cascadePath } = resolveStateHistoryPersistencePaths(
			this.historyPersistence,
			this.debugDir,
		);
		const [healthFingerprint, cascadeFingerprint] = await Promise.all([
			buildFileFingerprint(healthPath),
			buildFileFingerprint(cascadePath),
		]);
		return `health=${healthFingerprint};cascade=${cascadeFingerprint}`;
	}

	hydrateState(state: MultiAuthState): Promise<MultiAuthState> {
		if (!this.isEnabled()) {
			return Promise.resolve(state);
		}

		return this.readSnapshots().then(({ healthSnapshot, cascadeSnapshot }) => {
			mergeExtractedHealthHistory(state, healthSnapshot);
			mergeExtractedCascadeHistory(state, cascadeSnapshot);
			return state;
		});
	}

	async createPersistedState(state: MultiAuthState): Promise<MultiAuthState> {
		if (!this.isEnabled()) {
			return state;
		}

		const healthSnapshot = extractHealthHistory(state);
		const cascadeSnapshot = extractCascadeHistory(state);
		await this.writeSnapshots(healthSnapshot, cascadeSnapshot);
		stripHealthHistory(state);
		stripCascadeHistory(state);
		return state;
	}

	private async readSnapshots(): Promise<{
		healthSnapshot: HealthHistorySnapshot;
		cascadeSnapshot: CascadeHistorySnapshot;
	}> {
		const { healthPath, cascadePath } = resolveStateHistoryPersistencePaths(
			this.historyPersistence,
			this.debugDir,
		);
		const [healthSnapshot, cascadeSnapshot] = await Promise.all([
			readHistorySnapshot(
				healthPath,
				"extracted health history snapshot",
				"Invalid JSON in extracted health history snapshot:",
				parseHealthHistorySnapshot,
				createEmptyHealthHistorySnapshot,
			),
			readHistorySnapshot(
				cascadePath,
				"extracted cascade history snapshot",
				"Invalid JSON in extracted cascade history snapshot:",
				parseCascadeHistorySnapshot,
				createEmptyCascadeHistorySnapshot,
			),
		]);

		return {
			healthSnapshot,
			cascadeSnapshot,
		};
	}

	private async writeSnapshots(
		healthSnapshot: HealthHistorySnapshot,
		cascadeSnapshot: CascadeHistorySnapshot,
	): Promise<void> {
		const { healthPath, cascadePath } = resolveStateHistoryPersistencePaths(
			this.historyPersistence,
			this.debugDir,
		);
		await Promise.all([
			writeHistorySnapshot(
				healthPath,
				`${JSON.stringify(healthSnapshot, null, 2)}\n`,
				this.debugDir,
				"extracted health history snapshot",
			),
			writeHistorySnapshot(
				cascadePath,
				`${JSON.stringify(cascadeSnapshot, null, 2)}\n`,
				this.debugDir,
				"extracted cascade history snapshot",
			),
		]);
	}
}

export type { HealthHistorySnapshot, CascadeHistorySnapshot, ProviderRotationState };
