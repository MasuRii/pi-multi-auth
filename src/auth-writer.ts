import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OAuthCredentials } from "./oauth-compat.js";
import { resolveAgentRuntimePath } from "./runtime-paths.js";
import { multiAuthDebugLogger } from "./debug-logger.js";
import {
	isRetryableFileAccessError,
	readTextSnapshotWithRetries,
	writeTextSnapshotWithRetries,
} from "./file-retry.js";
import type {
	BackupAndStoreResult,
	StoredApiKeyCredential,
	StoredAuthCredential,
	StoredOAuthCredential,
	SupportedProviderId,
} from "./types.js";

type RawAuthFileData = Record<string, unknown>;

type LockResult<T> = {
	result: T;
	next?: RawAuthFileData;
};

export interface AuthCredentialEntry {
	credentialId: string;
	credential: StoredAuthCredential;
}

export interface ApiKeyProviderNormalizationResult {
	provider: SupportedProviderId;
	removedDuplicateCount: number;
	renumberedCredentialIds: boolean;
	credentialIds: string[];
	credentialIdMap: Record<string, string>;
}

type LockRetryOptions = {
	retries: number;
	factor: number;
	minTimeout: number;
	maxTimeout: number;
	randomize: boolean;
};

type LockOptions = {
	realpath?: boolean;
	retries: LockRetryOptions;
	stale: number;
	onCompromised?: (error: Error) => void;
};

function toError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}

	return new Error(String(error));
}

function sleep(ms: number): Promise<void> {
	if (ms <= 0) {
		return Promise.resolve();
	}

	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function lockDirPath(filePath: string): string {
	return `${filePath}.lock`;
}

async function acquireFileLock(filePath: string, options: LockOptions): Promise<() => Promise<void>> {
	const lockPath = lockDirPath(filePath);
	const maxAttempts = Math.max(0, options.retries.retries) + 1;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			await mkdir(lockPath, { mode: 0o700 });
			if (attempt > 1) {
				multiAuthDebugLogger.log("auth_lock_acquired_after_retry", {
					authPath: filePath,
					lockPath,
					attempt,
					maxAttempts,
				});
			}
			return async () => {
				await rm(lockPath, { recursive: true, force: true });
			};
		} catch (error) {
			const lockError = toError(error);
			const maybeCode = (lockError as Error & { code?: unknown }).code;

			if (maybeCode !== "EEXIST") {
				multiAuthDebugLogger.log("auth_lock_error", {
					authPath: filePath,
					lockPath,
					attempt,
					maxAttempts,
					error: lockError.message,
				});
				throw lockError;
			}

			try {
				const lockStats = await stat(lockPath);
				const ageMs = Date.now() - lockStats.mtimeMs;
				if (ageMs > options.stale) {
					await rm(lockPath, { recursive: true, force: true });
					multiAuthDebugLogger.log("auth_lock_removed_stale", {
						authPath: filePath,
						lockPath,
						attempt,
						maxAttempts,
						staleMs: options.stale,
						ageMs: Math.round(ageMs),
					});
					if (options.onCompromised) {
						options.onCompromised(
							new Error(`Removed stale lock '${lockPath}' older than ${Math.round(ageMs)}ms.`),
						);
					}
					// Decrement attempt so we retry the mkdir immediately after removing stale lock
					attempt -= 1;
					continue;
				}
			} catch {
				// Lock may be released while checking staleness; retry.
			}

			if (attempt >= maxAttempts) {
				multiAuthDebugLogger.log("auth_lock_timeout", {
					authPath: filePath,
					lockPath,
					attempt,
					maxAttempts,
					staleMs: options.stale,
				});
				throw new Error(`Timed out acquiring lock for '${filePath}' after ${maxAttempts} attempt(s).`);
			}

			const baseDelay = Math.min(
				options.retries.maxTimeout,
				Math.max(
					options.retries.minTimeout,
					Math.round(options.retries.minTimeout * Math.pow(options.retries.factor, attempt - 1)),
				),
			);
			const delay = options.retries.randomize
				? Math.round(baseDelay * (0.5 + Math.random()))
				: baseDelay;
			multiAuthDebugLogger.log("auth_lock_wait", {
				authPath: filePath,
				lockPath,
				attempt,
				maxAttempts,
				staleMs: options.stale,
				delayMs: delay,
			});
			await sleep(delay);
		}
	}

	throw new Error(`Failed to acquire lock for '${filePath}'.`);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function ensureParentDir(filePath: string): Promise<void> {
	const parentDir = dirname(filePath);
	if (!(await pathExists(parentDir))) {
		await mkdir(parentDir, { recursive: true, mode: 0o700 });
	}
}

async function ensureFileExists(filePath: string): Promise<void> {
	if (!(await pathExists(filePath))) {
		await writeFile(filePath, "{}", "utf-8");
		await chmod(filePath, 0o600);
	}
}

function getDefaultAuthPath(): string {
	return resolveAgentRuntimePath("auth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAuthData(content: string | undefined): RawAuthFileData {
	if (!content || content.trim() === "") {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(
			`Invalid JSON in auth.json: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!isRecord(parsed)) {
		throw new Error("Invalid auth.json format: expected a JSON object");
	}

	return parsed;
}

function isRetryableSnapshotReadError(error: Error): boolean {
	return (
		error.message.startsWith("Invalid JSON in auth.json:") ||
		error.message === "Invalid auth.json format: expected a JSON object" ||
		isRetryableFileAccessError(error)
	);
}

async function readAuthDataSnapshot(authPath: string): Promise<RawAuthFileData> {
	await ensureParentDir(authPath);
	await ensureFileExists(authPath);

	return readTextSnapshotWithRetries({
		filePath: authPath,
		failureMessage: `Failed to read auth.json snapshot from '${authPath}'.`,
		read: async () => ((await pathExists(authPath)) ? readFile(authPath, "utf-8") : undefined),
		parse: parseAuthData,
		resolveOnFinalEmpty: () => ({}),
		isRetryableError: isRetryableSnapshotReadError,
		onRetry: ({ attempt, maxAttempts, reason, delayMs }) => {
			multiAuthDebugLogger.log("auth_snapshot_retry", {
				authPath,
				attempt,
				maxAttempts,
				reason,
				delayMs,
			});
		},
		onRecovered: ({ attempt, maxAttempts }) => {
			multiAuthDebugLogger.log("auth_snapshot_recovered", {
				authPath,
				attempt,
				maxAttempts,
			});
		},
		onError: ({ attempt, maxAttempts, error }) => {
			multiAuthDebugLogger.log("auth_snapshot_error", {
				authPath,
				attempt,
				maxAttempts,
				error,
			});
		},
	});
}

function serializeAuthData(data: RawAuthFileData): string {
	return JSON.stringify(data, null, 2);
}

async function writeAuthDataSnapshot(authPath: string, data: RawAuthFileData): Promise<void> {
	const serialized = serializeAuthData(data);
	await writeTextSnapshotWithRetries({
		filePath: authPath,
		failureMessage: `Failed to persist auth.json to '${authPath}'.`,
		write: async () => {
			await writeFile(authPath, serialized, "utf-8");
			await chmod(authPath, 0o600);
		},
		isRetryableError: isRetryableFileAccessError,
		onRetry: ({ attempt, maxAttempts, reason, delayMs }) => {
			multiAuthDebugLogger.log("auth_snapshot_write_retry", {
				authPath,
				attempt,
				maxAttempts,
				reason,
				delayMs,
			});
		},
		onRecovered: ({ attempt, maxAttempts }) => {
			multiAuthDebugLogger.log("auth_snapshot_write_recovered", {
				authPath,
				attempt,
				maxAttempts,
			});
		},
		onError: ({ attempt, maxAttempts, error }) => {
			multiAuthDebugLogger.log("auth_snapshot_write_error", {
				authPath,
				attempt,
				maxAttempts,
				error,
			});
		},
	});
}

function cloneAuthData(data: RawAuthFileData): RawAuthFileData {
	return { ...data };
}

function isOAuthCredential(value: unknown): value is StoredOAuthCredential {
	if (!isRecord(value)) {
		return false;
	}

	if (value.type !== "oauth") {
		return false;
	}

	return (
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	);
}

function isApiKeyCredential(value: unknown): value is StoredApiKeyCredential {
	if (!isRecord(value)) {
		return false;
	}

	if (value.type !== "api_key") {
		return false;
	}

	return typeof value.key === "string";
}

function isStoredCredential(value: unknown): value is StoredAuthCredential {
	return isOAuthCredential(value) || isApiKeyCredential(value);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getNextBackupSuffix(provider: SupportedProviderId, data: RawAuthFileData): number {
	const expression = new RegExp(`^${escapeRegex(provider)}-(\\d+)$`);
	let maxSuffix = 0;
	for (const key of Object.keys(data)) {
		const match = expression.exec(key);
		if (!match) {
			continue;
		}
		const suffix = Number.parseInt(match[1], 10);
		if (Number.isInteger(suffix) && suffix > maxSuffix) {
			maxSuffix = suffix;
		}
	}
	return maxSuffix + 1;
}

function cloneStoredCredential(credential: StoredAuthCredential): StoredAuthCredential {
	if (credential.type === "oauth") {
		return { ...credential };
	}
	return { ...credential };
}

function hasBackupCredentialSibling(
	provider: string,
	data: RawAuthFileData,
	excludeCredentialId?: string,
): boolean {
	const expression = new RegExp(`^${escapeRegex(provider)}-(\\d+)$`);
	for (const credentialId of Object.keys(data)) {
		if (credentialId === excludeCredentialId) {
			continue;
		}
		if (!expression.test(credentialId)) {
			continue;
		}
		if (isStoredCredential(data[credentialId])) {
			return true;
		}
	}
	return false;
}

function maybeResolveBackupBaseProvider(
	credentialId: string,
	data: RawAuthFileData,
	knownProviders: ReadonlySet<string>,
): string | null {
	const match = /^(.*)-(\d+)$/.exec(credentialId);
	if (!match) {
		return null;
	}

	const maybeProvider = match[1]?.trim();
	if (!maybeProvider) {
		return null;
	}

	const primaryCredential = data[maybeProvider];
	if (
		isStoredCredential(primaryCredential) ||
		knownProviders.has(maybeProvider) ||
		hasBackupCredentialSibling(maybeProvider, data, credentialId)
	) {
		return maybeProvider;
	}

	return null;
}

function getExpectedProviderCredentialId(provider: SupportedProviderId, index: number): string {
	return index === 0 ? provider : `${provider}-${index}`;
}

/**
 * Writes the active agent runtime auth.json under the same lock path as AuthStorage.
 * Read-only access uses optimistic snapshots so provider selection is not blocked by long-lived core auth locks.
 */
export class AuthWriter {
	constructor(private readonly authPath: string = getDefaultAuthPath()) {}

	/**
	 * Returns the configured auth.json path.
	 */
	getPath(): string {
		return this.authPath;
	}

	private async readSnapshot(): Promise<RawAuthFileData> {
		return readAuthDataSnapshot(this.authPath);
	}

	/**
	 * Lists provider IDs found in auth.json.
	 */
	async listProviderIds(seedProviders: readonly string[] = []): Promise<string[]> {
		const data = await this.readSnapshot();
		return this.listProviderIdsFromData(data, new Set(seedProviders));
	}

	/**
	 * Reads the credential IDs for a provider in deterministic order.
	 */
	async listProviderCredentialIds(provider: SupportedProviderId): Promise<string[]> {
		const data = await this.readSnapshot();
		return this.listProviderCredentialIdsFromData(provider, data);
	}

	/**
	 * Reads any stored credential by credential ID.
	 */
	async getCredential(credentialId: string): Promise<StoredAuthCredential | undefined> {
		const credentials = await this.getCredentials([credentialId]);
		return credentials.get(credentialId);
	}

	/**
	 * Reads a deterministic credential snapshot for the provided credential IDs.
	 */
	async getCredentials(credentialIds: readonly string[]): Promise<Map<string, StoredAuthCredential>> {
		const uniqueCredentialIds = [...new Set(credentialIds.map((credentialId) => credentialId.trim()))].filter(
			(credentialId) => credentialId.length > 0,
		);
		if (uniqueCredentialIds.length === 0) {
			return new Map<string, StoredAuthCredential>();
		}

		const data = await this.readSnapshot();
		const credentials = new Map<string, StoredAuthCredential>();
		for (const credentialId of uniqueCredentialIds) {
			const credential = data[credentialId];
			if (!isStoredCredential(credential)) {
				continue;
			}
			credentials.set(credentialId, cloneStoredCredential(credential));
		}
		return credentials;
	}

	/**
	 * Reads a provider's credentials in deterministic order from a single auth.json snapshot.
	 */
	async getProviderCredentialEntries(provider: SupportedProviderId): Promise<AuthCredentialEntry[]> {
		const data = await this.readSnapshot();
		return this.getProviderCredentialEntriesFromData(provider, data);
	}

	/**
	 * Reads an OAuth credential by credential ID.
	 */
	async getOAuthCredential(credentialId: string): Promise<StoredOAuthCredential | undefined> {
		const credential = await this.getCredential(credentialId);
		return credential?.type === "oauth" ? credential : undefined;
	}

	/**
	 * Persists an OAuth credential at the given credential ID.
	 */
	async setOAuthCredential(credentialId: string, credential: OAuthCredentials): Promise<void> {
		await this.withLock((data) => {
			const next = cloneAuthData(data);
			next[credentialId] = {
				type: "oauth",
				...credential,
			};
			return { result: undefined, next };
		});
	}

	/**
	 * Persists an API-key credential at the given credential ID.
	 */
	async setApiKeyCredential(credentialId: string, key: string): Promise<void> {
		const normalized = key.trim();
		if (!normalized) {
			throw new Error("API key cannot be empty.");
		}

		await this.withLock((data) => {
			const next = cloneAuthData(data);
			next[credentialId] = {
				type: "api_key",
				key: normalized,
			};
			return { result: undefined, next };
		});
	}

	/**
	 * Stores OAuth credentials in provider slot (first account) or provider-N backup slot.
	 */
	async setOAuthCredentialAsBackup(
		provider: SupportedProviderId,
		credential: OAuthCredentials,
	): Promise<BackupAndStoreResult> {
		return this.withLock((data) => {
			const next = cloneAuthData(data);
			const destination = this.getBackupDestinationCredentialId(provider, next);
			next[destination.credentialId] = {
				type: "oauth",
				...credential,
			};

			const credentialIds = this.listProviderCredentialIdsFromData(provider, next);
			return {
				result: {
					credentialId: destination.credentialId,
					isBackupCredential: destination.isBackup,
					credentialIds,
				},
				next,
			};
		});
	}

	/**
	 * Stores API-key credentials in provider slot (first account) or provider-N backup slot.
	 */
	async setApiKeyCredentialAsBackup(
		provider: SupportedProviderId,
		key: string,
	): Promise<BackupAndStoreResult> {
		const normalized = key.trim();
		if (!normalized) {
			throw new Error("API key cannot be empty.");
		}

		return this.withLock((data) => {
			const existingEntries = this.getProviderCredentialEntriesFromData(provider, data);
			const uniqueCredentials: StoredAuthCredential[] = [];
			const firstIndexByApiKey = new Map<string, number>();
			let deduplicatedCount = 0;

			for (const entry of existingEntries) {
				const credential = cloneStoredCredential(entry.credential);
				if (credential.type === "api_key") {
					const normalizedExistingKey = credential.key.trim();
					if (!normalizedExistingKey) {
						deduplicatedCount += 1;
						continue;
					}
					if (firstIndexByApiKey.has(normalizedExistingKey)) {
						deduplicatedCount += 1;
						continue;
					}
					credential.key = normalizedExistingKey;
					firstIndexByApiKey.set(normalizedExistingKey, uniqueCredentials.length);
				}
				uniqueCredentials.push(credential);
			}

			let targetIndex = firstIndexByApiKey.get(normalized);
			const didAddCredential = targetIndex === undefined;
			if (didAddCredential) {
				targetIndex = uniqueCredentials.length;
				uniqueCredentials.push({
					type: "api_key",
					key: normalized,
				});
				firstIndexByApiKey.set(normalized, targetIndex);
			}

			const existingCredentialIds = existingEntries.map((entry) => entry.credentialId);
			const next = cloneAuthData(data);
			for (const credentialId of existingCredentialIds) {
				delete next[credentialId];
			}

			const credentialIds: string[] = [];
			for (const [index, credential] of uniqueCredentials.entries()) {
				const credentialId = index === 0 ? provider : `${provider}-${index}`;
				next[credentialId] = credential;
				credentialIds.push(credentialId);
			}

			const renumberedCredentialIds = existingCredentialIds.some((credentialId, index) => {
				const expectedCredentialId = index === 0 ? provider : `${provider}-${index}`;
				return credentialId !== expectedCredentialId;
			});
			const resolvedIndex = targetIndex ?? 0;
			const resolvedCredentialId = credentialIds[resolvedIndex] ?? provider;
			return {
				result: {
					credentialId: resolvedCredentialId,
					isBackupCredential: resolvedIndex > 0,
					credentialIds,
					didAddCredential,
					duplicateOfCredentialId: didAddCredential ? undefined : resolvedCredentialId,
					deduplicatedCount,
					renumberedCredentialIds,
				},
				next,
			};
		});
	}

	private normalizeProviderCredentialsFromData(
		data: RawAuthFileData,
		seedProviders: readonly string[] = [],
	): {
		hasChanges: boolean;
		next: RawAuthFileData;
		changedProviders: ApiKeyProviderNormalizationResult[];
	} {
		const next = cloneAuthData(data);
		const providers = this.listProviderIdsFromData(next, new Set(seedProviders));
		const changedProviders: ApiKeyProviderNormalizationResult[] = [];
		let hasChanges = false;

		for (const provider of providers) {
			const entries = this.getProviderCredentialEntriesFromData(provider, next);
			if (entries.length === 0) {
				continue;
			}

			const existingCredentialIds = entries.map((entry) => entry.credentialId);
			const retainedEntries: Array<{
				credentialId: string;
				credential: StoredAuthCredential;
			}> = [];
			const seenApiKeys = new Set<string>();
			let removedDuplicateCount = 0;

			for (const entry of entries) {
				const credential = cloneStoredCredential(entry.credential);
				if (credential.type === "api_key") {
					const normalizedKey = credential.key.trim();
					if (!normalizedKey) {
						removedDuplicateCount += 1;
						continue;
					}
					if (seenApiKeys.has(normalizedKey)) {
						removedDuplicateCount += 1;
						continue;
					}
					credential.key = normalizedKey;
					seenApiKeys.add(normalizedKey);
				}
				retainedEntries.push({
					credentialId: entry.credentialId,
					credential,
				});
			}

			for (const credentialId of existingCredentialIds) {
				delete next[credentialId];
			}

			const normalizedCredentialIds: string[] = [];
			const credentialIdMap: Record<string, string> = {};
			for (const [index, entry] of retainedEntries.entries()) {
				const credentialId = getExpectedProviderCredentialId(provider, index);
				next[credentialId] = entry.credential;
				normalizedCredentialIds.push(credentialId);
				credentialIdMap[entry.credentialId] = credentialId;
			}

			const renumberedCredentialIds = retainedEntries.some(
				(entry, index) => entry.credentialId !== getExpectedProviderCredentialId(provider, index),
			);

			const providerChanged = removedDuplicateCount > 0 || renumberedCredentialIds;
			if (providerChanged) {
				hasChanges = true;
				changedProviders.push({
					provider,
					removedDuplicateCount,
					renumberedCredentialIds,
					credentialIds: normalizedCredentialIds,
					credentialIdMap,
				});
			}
		}

		return {
			hasChanges,
			next,
			changedProviders,
		};
	}

	/**
	 * Renumbers provider credential IDs sequentially and deduplicates API-key entries.
	 */
	async normalizeProviderCredentials(
		seedProviders: readonly string[] = [],
	): Promise<ApiKeyProviderNormalizationResult[]> {
		const snapshot = await this.readSnapshot();
		const analyzedSnapshot = this.normalizeProviderCredentialsFromData(snapshot, seedProviders);
		if (!analyzedSnapshot.hasChanges) {
			return analyzedSnapshot.changedProviders;
		}

		return this.withLock((data) => {
			const normalized = this.normalizeProviderCredentialsFromData(data, seedProviders);
			return normalized.hasChanges
				? { result: normalized.changedProviders, next: normalized.next }
				: { result: normalized.changedProviders };
		});
	}

	/**
	 * Backward-compatible wrapper retained for existing normalization flows.
	 */
	async normalizeApiKeyProviders(
		seedProviders: readonly string[] = [],
	): Promise<ApiKeyProviderNormalizationResult[]> {
		return this.normalizeProviderCredentials(seedProviders);
	}

	/**
	 * Backward-compatible method retained for existing OAuth flows.
	 */
	async backupAndStorePrimaryCredential(
		provider: SupportedProviderId,
		credential: OAuthCredentials,
	): Promise<BackupAndStoreResult> {
		return this.setOAuthCredentialAsBackup(provider, credential);
	}

	/**
	 * Executes an auth.json transaction under file lock.
	 */
	async withLock<T>(
		fn: (data: RawAuthFileData) => Promise<LockResult<T>> | LockResult<T>,
	): Promise<T> {
		await ensureParentDir(this.authPath);
		await ensureFileExists(this.authPath);

		let release: (() => Promise<void>) | undefined;

		try {
			release = await acquireFileLock(this.authPath, {
				realpath: false,
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10_000,
					randomize: true,
				},
				stale: 30_000,
				onCompromised: () => {
					// Stale lock cleanup happened; continue transaction under the new lock.
				},
			});

			const parsed = await readAuthDataSnapshot(this.authPath);
			const lockResult = await fn(cloneAuthData(parsed));

			if (lockResult.next) {
				const serializedCurrent = serializeAuthData(parsed);
				const serializedNext = serializeAuthData(lockResult.next);
				if (serializedNext !== serializedCurrent) {
					await writeAuthDataSnapshot(this.authPath, lockResult.next);
				}
			}
			return lockResult.result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock failures when lock is compromised.
				}
			}
		}
	}

	private getProviderCredentialEntriesFromData(
		provider: SupportedProviderId,
		data: RawAuthFileData,
	): AuthCredentialEntry[] {
		const credentialIds = this.listProviderCredentialIdsFromData(provider, data);
		const entries: AuthCredentialEntry[] = [];
		for (const credentialId of credentialIds) {
			const credential = data[credentialId];
			if (!isStoredCredential(credential)) {
				continue;
			}
			entries.push({
				credentialId,
				credential: cloneStoredCredential(credential),
			});
		}
		return entries;
	}

	private listProviderIdsFromData(data: RawAuthFileData, knownProviders: ReadonlySet<string>): string[] {
		const providers: string[] = [];
		const seen = new Set<string>();

		for (const [credentialId, value] of Object.entries(data)) {
			if (!isStoredCredential(value)) {
				continue;
			}

			const backupBase = maybeResolveBackupBaseProvider(credentialId, data, knownProviders);
			const provider = backupBase ?? credentialId;
			if (seen.has(provider)) {
				continue;
			}
			seen.add(provider);
			providers.push(provider);
		}

		return providers;
	}

	private listProviderCredentialIdsFromData(
		provider: SupportedProviderId,
		data: RawAuthFileData,
	): string[] {
		const credentialIds: string[] = [];

		if (isStoredCredential(data[provider])) {
			credentialIds.push(provider);
		}

		const expression = new RegExp(`^${escapeRegex(provider)}-(\\d+)$`);
		const suffixEntries = Object.keys(data)
			.map((credentialId) => {
				const match = expression.exec(credentialId);
				if (!match) {
					return undefined;
				}
				const suffix = Number.parseInt(match[1], 10);
				if (!Number.isInteger(suffix) || !isStoredCredential(data[credentialId])) {
					return undefined;
				}
				return { credentialId, suffix };
			})
			.filter((entry): entry is { credentialId: string; suffix: number } => entry !== undefined)
			.sort((left, right) => left.suffix - right.suffix);

		for (const entry of suffixEntries) {
			credentialIds.push(entry.credentialId);
		}

		return credentialIds;
	}

	private getBackupDestinationCredentialId(
		provider: SupportedProviderId,
		data: RawAuthFileData,
	): { credentialId: string; isBackup: boolean } {
		if (!isStoredCredential(data[provider])) {
			return {
				credentialId: provider,
				isBackup: false,
			};
		}

		const nextSuffix = getNextBackupSuffix(provider, data);
		return {
			credentialId: `${provider}-${nextSuffix}`,
			isBackup: true,
		};
	}
}
