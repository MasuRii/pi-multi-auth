import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getErrorMessage, isRecord } from "../auth-error-utils.js";
import { multiAuthDebugLogger } from "../debug-logger.js";
import {
	isRetryableFileAccessError,
	readTextSnapshotWithRetries,
	writeTextSnapshotWithRetries,
} from "../file-retry.js";
import { resolveAgentRuntimePath } from "../runtime-paths.js";
import type { ParsedRateLimitHeaders, QuotaClassification } from "../types-quota.js";
import type { UsageFetchResult, UsageSnapshot } from "./types.js";

export const USAGE_CACHE_SCHEMA_VERSION = 2;
export const DEFAULT_USAGE_CACHE_MAX_ENTRIES = 5_000;
export const DEFAULT_USAGE_DISPLAY_CACHE_RETENTION_MS = 30 * 24 * 60 * 60_000;

const USAGE_CACHE_LEGACY_SCHEMA_VERSION = 1;

const QUOTA_CLASSIFICATIONS = new Set<QuotaClassification>([
	"hourly",
	"daily",
	"weekly",
	"monthly",
	"balance",
	"organization",
	"unknown",
]);
const RATE_LIMIT_CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);
const RATE_LIMIT_SOURCE_VALUES = new Set([
	"x-ratelimit-reset",
	"retry-after",
	"estimated",
	"unknown",
]);

export interface UsageCachePersistenceOptions {
	filePath?: string;
	maxEntries?: number;
	displayMaxEntries?: number;
	displayRetentionMs?: number;
}

export interface UsageCacheRecord {
	providerId: string;
	credentialId: string;
	credentialCacheKey: string;
	result: Omit<UsageFetchResult, "fromCache">;
	freshUntil: number;
	staleUntil: number;
}

export interface UsageDisplayCacheRecord {
	providerId: string;
	credentialId: string;
	credentialCacheKey: string;
	result: Omit<UsageFetchResult, "fromCache">;
	displayUntil: number;
}

export interface UsageCacheHydrationRecords {
	operationalEntries: UsageCacheRecord[];
	displayEntries: UsageDisplayCacheRecord[];
}

export interface UsageCacheHydrationOptions {
	isCredentialValid?: (providerId: string, credentialId: string, credentialCacheKey: string) => boolean;
	isDisplayCredentialValid?: (providerId: string, credentialId: string, credentialCacheKey: string) => boolean;
	resolveLegacyCredentialCacheKey?: (providerId: string, credentialId: string) => string | null;
	pruneInvalidEntries?: boolean;
}

interface PersistedUsageCacheFile {
	schemaVersion: typeof USAGE_CACHE_SCHEMA_VERSION;
	generatedAt: number;
	maxEntries: number;
	maxDisplayEntries: number;
	displayRetentionMs: number;
	entries: PersistedUsageCacheEntry[];
	displayEntries: PersistedUsageDisplayCacheEntry[];
}

interface ParsedPersistedUsageCacheFile {
	entries: PersistedUsageCacheEntry[];
	displayEntries: PersistedUsageDisplayCacheEntry[];
	shouldRewrite: boolean;
}

interface CredentialScopedUsageCacheEntry {
	provider: string;
	credentialId: string;
	credentialCacheKey: string;
	fetchedAt: number;
	snapshot: UsageSnapshot;
}

interface PersistedUsageCacheEntry extends CredentialScopedUsageCacheEntry {
	freshUntil: number;
	staleUntil: number;
}

interface PersistedUsageDisplayCacheEntry extends CredentialScopedUsageCacheEntry {
	displayUntil: number;
}

type PersistedCopilotQuotaBucket = NonNullable<UsageSnapshot["copilotQuota"]>["chat"];

function getDefaultUsageCachePath(): string {
	return resolveAgentRuntimePath("multi-auth-usage-cache.json");
}


function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isFiniteTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
	return value === null || isFiniteTimestamp(value);
}

function createRecordKey(providerId: string, credentialId: string, credentialCacheKey: string): string {
	return `${providerId}:${credentialId}:${credentialCacheKey}`;
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

function parseRateLimitWindow(value: unknown): UsageSnapshot["primary"] | null | undefined {
	if (value === null) {
		return null;
	}
	if (!isRecord(value)) {
		return undefined;
	}
	if (!isFiniteTimestamp(value.usedPercent)) {
		return undefined;
	}
	if (!isNullableFiniteNumber(value.windowMinutes) || !isNullableFiniteNumber(value.resetsAt)) {
		return undefined;
	}
	return {
		usedPercent: value.usedPercent,
		windowMinutes: value.windowMinutes,
		resetsAt: value.resetsAt,
	};
}

function parseCredits(value: unknown): UsageSnapshot["credits"] | null | undefined {
	if (value === null) {
		return null;
	}
	if (!isRecord(value)) {
		return undefined;
	}
	if (typeof value.hasCredits !== "boolean" || typeof value.unlimited !== "boolean") {
		return undefined;
	}
	if (value.balance !== null && typeof value.balance !== "string") {
		return undefined;
	}
	return {
		hasCredits: value.hasCredits,
		unlimited: value.unlimited,
		balance: value.balance,
	};
}

function parseCopilotQuotaBucket(value: unknown): PersistedCopilotQuotaBucket | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (
		!isNullableFiniteNumber(value.used) ||
		!isNullableFiniteNumber(value.total) ||
		!isNullableFiniteNumber(value.remaining) ||
		!isNullableFiniteNumber(value.percentUsed) ||
		typeof value.unlimited !== "boolean"
	) {
		return undefined;
	}
	return {
		used: value.used,
		total: value.total,
		remaining: value.remaining,
		percentUsed: value.percentUsed,
		unlimited: value.unlimited,
	};
}

function parseCopilotQuota(value: unknown): UsageSnapshot["copilotQuota"] | null | undefined {
	if (value === null) {
		return null;
	}
	if (!isRecord(value)) {
		return undefined;
	}
	const chat = parseCopilotQuotaBucket(value.chat);
	if (!chat) {
		return undefined;
	}
	let completions: PersistedCopilotQuotaBucket | null;
	if (value.completions === null) {
		completions = null;
	} else {
		const parsedCompletions = parseCopilotQuotaBucket(value.completions);
		if (!parsedCompletions) {
			return undefined;
		}
		completions = parsedCompletions;
	}
	if (!isNullableFiniteNumber(value.resetAt)) {
		return undefined;
	}
	return {
		chat,
		completions,
		resetAt: value.resetAt,
	};
}

function parseRateLimitHeaders(value: unknown): ParsedRateLimitHeaders | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		return undefined;
	}
	if (
		!isNullableFiniteNumber(value.limit) ||
		!isNullableFiniteNumber(value.remaining) ||
		!isNullableFiniteNumber(value.resetAt) ||
		!isNullableFiniteNumber(value.retryAfterSeconds) ||
		(value.resetAtFormatted !== null && typeof value.resetAtFormatted !== "string") ||
		typeof value.confidence !== "string" ||
		!RATE_LIMIT_CONFIDENCE_VALUES.has(value.confidence) ||
		typeof value.source !== "string" ||
		!RATE_LIMIT_SOURCE_VALUES.has(value.source)
	) {
		return undefined;
	}
	return {
		limit: value.limit,
		remaining: value.remaining,
		resetAt: value.resetAt,
		retryAfterSeconds: value.retryAfterSeconds,
		resetAtFormatted: value.resetAtFormatted,
		confidence: value.confidence as ParsedRateLimitHeaders["confidence"],
		source: value.source as ParsedRateLimitHeaders["source"],
	};
}

function parseQuotaClassification(value: unknown): QuotaClassification | undefined {
	if (value === undefined) {
		return undefined;
	}
	return typeof value === "string" && QUOTA_CLASSIFICATIONS.has(value as QuotaClassification)
		? (value as QuotaClassification)
		: undefined;
}

function parseUsageSnapshot(value: unknown): UsageSnapshot | null {
	if (!isRecord(value)) {
		return null;
	}
	if (
		!isFiniteTimestamp(value.timestamp) ||
		!isNonEmptyString(value.provider) ||
		(value.planType !== null && typeof value.planType !== "string") ||
		!isFiniteTimestamp(value.updatedAt)
	) {
		return null;
	}

	const primary = parseRateLimitWindow(value.primary);
	const secondary = parseRateLimitWindow(value.secondary);
	const credits = parseCredits(value.credits);
	const copilotQuota = parseCopilotQuota(value.copilotQuota);
	if (primary === undefined || secondary === undefined || credits === undefined || copilotQuota === undefined) {
		return null;
	}

	const rateLimitHeaders = parseRateLimitHeaders(value.rateLimitHeaders);
	if (value.rateLimitHeaders !== undefined && !rateLimitHeaders) {
		return null;
	}
	const quotaClassification = parseQuotaClassification(value.quotaClassification);
	if (value.quotaClassification !== undefined && !quotaClassification) {
		return null;
	}
	if (value.estimatedResetAt !== undefined && !isFiniteTimestamp(value.estimatedResetAt)) {
		return null;
	}

	return {
		timestamp: value.timestamp,
		provider: value.provider,
		planType: value.planType,
		primary,
		secondary,
		credits,
		copilotQuota,
		updatedAt: value.updatedAt,
		...(rateLimitHeaders ? { rateLimitHeaders } : {}),
		...(quotaClassification ? { quotaClassification } : {}),
		...(typeof value.estimatedResetAt === "number" ? { estimatedResetAt: value.estimatedResetAt } : {}),
	};
}

function parsePersistedEntry(value: unknown): PersistedUsageCacheEntry | null {
	if (!isRecord(value)) {
		return null;
	}
	if (!isNonEmptyString(value.credentialCacheKey)) {
		return null;
	}
	return parseCredentialScopedEntry(value, value.credentialCacheKey);
}

function parsePersistedDisplayEntry(value: unknown): PersistedUsageDisplayCacheEntry | null {
	if (!isRecord(value) || !isNonEmptyString(value.credentialCacheKey)) {
		return null;
	}
	if (
		!isNonEmptyString(value.provider) ||
		!isNonEmptyString(value.credentialId) ||
		!isFiniteTimestamp(value.fetchedAt) ||
		!isFiniteTimestamp(value.displayUntil)
	) {
		return null;
	}
	const snapshot = parseUsageSnapshot(value.snapshot);
	if (!snapshot || snapshot.provider !== value.provider) {
		return null;
	}
	return {
		provider: value.provider,
		credentialId: value.credentialId,
		credentialCacheKey: value.credentialCacheKey,
		fetchedAt: value.fetchedAt,
		displayUntil: value.displayUntil,
		snapshot,
	};
}

function parseLegacyPersistedEntry(
	value: unknown,
	options: UsageCacheHydrationOptions,
): PersistedUsageCacheEntry | null {
	if (!isRecord(value)) {
		return null;
	}
	if (!isNonEmptyString(value.provider) || !isNonEmptyString(value.credentialId)) {
		return null;
	}
	const credentialCacheKey = resolveLegacyCredentialCacheKey(value.provider, value.credentialId, options);
	if (!credentialCacheKey) {
		return null;
	}
	return parseCredentialScopedEntry(value, credentialCacheKey);
}

function parseCredentialScopedEntry(
	value: Record<string, unknown>,
	credentialCacheKey: string,
): PersistedUsageCacheEntry | null {
	if (
		!isNonEmptyString(value.provider) ||
		!isNonEmptyString(value.credentialId) ||
		!isFiniteTimestamp(value.fetchedAt) ||
		!isFiniteTimestamp(value.freshUntil) ||
		!isFiniteTimestamp(value.staleUntil) ||
		value.freshUntil > value.staleUntil
	) {
		return null;
	}
	const snapshot = parseUsageSnapshot(value.snapshot);
	if (!snapshot || snapshot.provider !== value.provider) {
		return null;
	}
	return {
		provider: value.provider,
		credentialId: value.credentialId,
		credentialCacheKey,
		fetchedAt: value.fetchedAt,
		freshUntil: value.freshUntil,
		staleUntil: value.staleUntil,
		snapshot,
	};
}

function resolveLegacyCredentialCacheKey(
	providerId: string,
	credentialId: string,
	options: UsageCacheHydrationOptions,
): string | null {
	if (!options.resolveLegacyCredentialCacheKey) {
		return null;
	}
	try {
		const credentialCacheKey = options.resolveLegacyCredentialCacheKey(providerId, credentialId);
		if (typeof credentialCacheKey !== "string") {
			return null;
		}
		const normalized = credentialCacheKey.trim();
		return normalized.length > 0 ? normalized : null;
	} catch (error: unknown) {
		multiAuthDebugLogger.log("usage_cache_legacy_key_resolution_error", {
			provider: providerId,
			credentialId,
			error: getErrorMessage(error),
		});
		return null;
	}
}

function compareEntriesForRetention(
	left: CredentialScopedUsageCacheEntry,
	right: CredentialScopedUsageCacheEntry,
): number {
	const fetchedDelta = right.fetchedAt - left.fetchedAt;
	if (fetchedDelta !== 0) {
		return fetchedDelta;
	}
	const providerDelta = left.provider.localeCompare(right.provider);
	if (providerDelta !== 0) {
		return providerDelta;
	}
	return left.credentialId.localeCompare(right.credentialId);
}

function isEntryAllowed(
	entry: CredentialScopedUsageCacheEntry,
	options: UsageCacheHydrationOptions,
): boolean {
	if (!options.isCredentialValid) {
		return true;
	}
	try {
		return options.isCredentialValid(entry.provider, entry.credentialId, entry.credentialCacheKey);
	} catch (error: unknown) {
		multiAuthDebugLogger.log("usage_cache_credential_validation_error", {
			provider: entry.provider,
			credentialId: entry.credentialId,
			error: getErrorMessage(error),
		});
		return false;
	}
}

function isDisplayEntryAllowed(
	entry: CredentialScopedUsageCacheEntry,
	options: UsageCacheHydrationOptions,
): boolean {
	const validator = options.isDisplayCredentialValid ?? options.isCredentialValid;
	if (!validator) {
		return true;
	}
	try {
		return validator(entry.provider, entry.credentialId, entry.credentialCacheKey);
	} catch (error: unknown) {
		multiAuthDebugLogger.log("usage_cache_display_credential_validation_error", {
			provider: entry.provider,
			credentialId: entry.credentialId,
			error: getErrorMessage(error),
		});
		return false;
	}
}

export class UsageSnapshotCacheStore {
	private readonly filePath: string;
	private readonly maxEntries: number;
	private readonly displayMaxEntries: number;
	private readonly displayRetentionMs: number;

	constructor(options: UsageCachePersistenceOptions = {}) {
		this.filePath = options.filePath ?? getDefaultUsageCachePath();
		this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_USAGE_CACHE_MAX_ENTRIES));
		this.displayMaxEntries = Math.max(1, Math.floor(options.displayMaxEntries ?? this.maxEntries));
		this.displayRetentionMs = Math.max(1, Math.floor(options.displayRetentionMs ?? DEFAULT_USAGE_DISPLAY_CACHE_RETENTION_MS));
	}

	getPath(): string {
		return this.filePath;
	}

	async readEntries(
		now: number = Date.now(),
		options: UsageCacheHydrationOptions = {},
	): Promise<UsageCacheRecord[]> {
		return (await this.readHydrationEntries(now, options)).operationalEntries;
	}

	async readDisplayEntries(
		now: number = Date.now(),
		options: UsageCacheHydrationOptions = {},
	): Promise<UsageDisplayCacheRecord[]> {
		return (await this.readHydrationEntries(now, options)).displayEntries;
	}

	async readHydrationEntries(
		now: number = Date.now(),
		options: UsageCacheHydrationOptions = {},
	): Promise<UsageCacheHydrationRecords> {
		const persisted = await this.readPersistedEntries(options);
		const operationalEntries = this.pruneEntries(persisted.entries, now, options);
		const displayEntries = this.pruneDisplayEntries(persisted.displayEntries, now, options);
		if (
			options.pruneInvalidEntries &&
			(
				persisted.shouldRewrite ||
				this.haveEntriesChanged(persisted.entries, operationalEntries) ||
				this.haveEntriesChanged(persisted.displayEntries, displayEntries)
			)
		) {
			await this.writeEntries(operationalEntries, displayEntries, now);
		}
		return {
			operationalEntries: operationalEntries.map((entry) => ({
				providerId: entry.provider,
				credentialId: entry.credentialId,
				credentialCacheKey: entry.credentialCacheKey,
				result: {
					snapshot: entry.snapshot,
					error: null,
					fetchedAt: entry.fetchedAt,
				},
				freshUntil: entry.freshUntil,
				staleUntil: entry.staleUntil,
			})),
			displayEntries: displayEntries.map((entry) => this.toDisplayCacheRecord(entry)),
		};
	}

	async persistSuccessfulEntry(
		entry: UsageCacheRecord,
		now: number = Date.now(),
	): Promise<UsageDisplayCacheRecord | null> {
		if (!entry.result.snapshot || entry.result.error) {
			return null;
		}
		const persistedEntry: PersistedUsageCacheEntry = {
			provider: entry.providerId,
			credentialId: entry.credentialId,
			credentialCacheKey: entry.credentialCacheKey,
			fetchedAt: entry.result.fetchedAt,
			freshUntil: entry.freshUntil,
			staleUntil: entry.staleUntil,
			snapshot: entry.result.snapshot,
		};
		const displayEntry: PersistedUsageDisplayCacheEntry = {
			provider: entry.providerId,
			credentialId: entry.credentialId,
			credentialCacheKey: entry.credentialCacheKey,
			fetchedAt: entry.result.fetchedAt,
			displayUntil: entry.result.fetchedAt + this.displayRetentionMs,
			snapshot: entry.result.snapshot,
		};
		const persisted = await this.readPersistedEntries();
		const displayEntries = this.pruneDisplayEntries([...persisted.displayEntries, displayEntry], now);
		await this.writeEntries(
			this.pruneEntries([...persisted.entries, persistedEntry], now),
			displayEntries,
			now,
		);
		return this.toDisplayCacheRecord(
			displayEntries.find((candidate) =>
				candidate.provider === displayEntry.provider &&
				candidate.credentialId === displayEntry.credentialId &&
				candidate.credentialCacheKey === displayEntry.credentialCacheKey,
			) ?? null,
		);
	}

	private toDisplayCacheRecord(entry: PersistedUsageDisplayCacheEntry): UsageDisplayCacheRecord;
	private toDisplayCacheRecord(entry: null): null;
	private toDisplayCacheRecord(entry: PersistedUsageDisplayCacheEntry | null): UsageDisplayCacheRecord | null;
	private toDisplayCacheRecord(entry: PersistedUsageDisplayCacheEntry | null): UsageDisplayCacheRecord | null {
		if (!entry) {
			return null;
		}
		return {
			providerId: entry.provider,
			credentialId: entry.credentialId,
			credentialCacheKey: entry.credentialCacheKey,
			result: {
				snapshot: entry.snapshot,
				error: null,
				fetchedAt: entry.fetchedAt,
			},
			displayUntil: entry.displayUntil,
		};
	}

	private async readPersistedEntries(
		options: UsageCacheHydrationOptions = {},
	): Promise<ParsedPersistedUsageCacheFile> {
		try {
			return await readTextSnapshotWithRetries({
				filePath: this.filePath,
				failureMessage: `Failed to read usage cache snapshot from '${this.filePath}'.`,
				read: async () => ((await pathExists(this.filePath)) ? readFile(this.filePath, "utf-8") : undefined),
				parse: (content) => this.parsePersistedContent(content, options),
				resolveOnFinalEmpty: () => ({ entries: [], displayEntries: [], shouldRewrite: false }),
				isRetryableError: isRetryableFileAccessError,
				onRetry: ({ attempt, maxAttempts, reason, delayMs }) => {
					multiAuthDebugLogger.log("usage_cache_read_retry", {
						cachePath: this.filePath,
						attempt,
						maxAttempts,
						reason,
						delayMs,
					});
				},
				onRecovered: ({ attempt, maxAttempts }) => {
					multiAuthDebugLogger.log("usage_cache_read_recovered", {
						cachePath: this.filePath,
						attempt,
						maxAttempts,
					});
				},
				onError: ({ attempt, maxAttempts, error }) => {
					multiAuthDebugLogger.log("usage_cache_read_error", {
						cachePath: this.filePath,
						attempt,
						maxAttempts,
						error,
					});
				},
			});
		} catch (error: unknown) {
			multiAuthDebugLogger.log("usage_cache_read_failed", {
				cachePath: this.filePath,
				error: getErrorMessage(error),
			});
			return { entries: [], displayEntries: [], shouldRewrite: false };
		}
	}

	private parsePersistedContent(
		content: string | undefined,
		options: UsageCacheHydrationOptions,
	): ParsedPersistedUsageCacheFile {
		if (content === undefined || content.trim() === "") {
			return { entries: [], displayEntries: [], shouldRewrite: false };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch (error: unknown) {
			multiAuthDebugLogger.log("usage_cache_malformed_json", {
				cachePath: this.filePath,
				error: getErrorMessage(error),
			});
			return { entries: [], displayEntries: [], shouldRewrite: false };
		}
		if (!isRecord(parsed)) {
			multiAuthDebugLogger.log("usage_cache_invalid_schema", { cachePath: this.filePath });
			return { entries: [], displayEntries: [], shouldRewrite: false };
		}
		const isCurrentSchema = parsed.schemaVersion === USAGE_CACHE_SCHEMA_VERSION;
		const isLegacySchema = parsed.schemaVersion === USAGE_CACHE_LEGACY_SCHEMA_VERSION;
		if (!isCurrentSchema && !isLegacySchema) {
			multiAuthDebugLogger.log("usage_cache_invalid_schema", { cachePath: this.filePath });
			return { entries: [], displayEntries: [], shouldRewrite: false };
		}
		if (!Array.isArray(parsed.entries)) {
			multiAuthDebugLogger.log("usage_cache_invalid_entries", { cachePath: this.filePath });
			return { entries: [], displayEntries: [], shouldRewrite: isLegacySchema };
		}
		const entries: PersistedUsageCacheEntry[] = [];
		let discardedEntry = false;
		for (const rawEntry of parsed.entries) {
			const entry = isLegacySchema
				? parseLegacyPersistedEntry(rawEntry, options)
				: parsePersistedEntry(rawEntry);
			if (entry) {
				entries.push(entry);
			} else {
				discardedEntry = true;
			}
		}

		const displayEntries: PersistedUsageDisplayCacheEntry[] = [];
		if (isCurrentSchema && parsed.displayEntries !== undefined) {
			if (Array.isArray(parsed.displayEntries)) {
				for (const rawEntry of parsed.displayEntries) {
					const entry = parsePersistedDisplayEntry(rawEntry);
					if (entry) {
						displayEntries.push(entry);
					} else {
						discardedEntry = true;
					}
				}
			} else {
				discardedEntry = true;
			}
		}

		return {
			entries,
			displayEntries,
			shouldRewrite: isLegacySchema || discardedEntry,
		};
	}

	private pruneEntries(
		entries: readonly PersistedUsageCacheEntry[],
		now: number,
		options: UsageCacheHydrationOptions = {},
	): PersistedUsageCacheEntry[] {
		const latestByCredential = new Map<string, PersistedUsageCacheEntry>();
		for (const entry of entries) {
			if (entry.staleUntil <= now || !isEntryAllowed(entry, options)) {
				continue;
			}
			const key = createRecordKey(entry.provider, entry.credentialId, entry.credentialCacheKey);
			const existing = latestByCredential.get(key);
			if (!existing || compareEntriesForRetention(entry, existing) < 0) {
				latestByCredential.set(key, entry);
			}
		}
		return [...latestByCredential.values()]
			.sort(compareEntriesForRetention)
			.slice(0, this.maxEntries);
	}

	private pruneDisplayEntries(
		entries: readonly PersistedUsageDisplayCacheEntry[],
		now: number,
		options: UsageCacheHydrationOptions = {},
	): PersistedUsageDisplayCacheEntry[] {
		const latestByCredential = new Map<string, PersistedUsageDisplayCacheEntry>();
		for (const entry of entries) {
			if (entry.displayUntil <= now || !isDisplayEntryAllowed(entry, options)) {
				continue;
			}
			const key = createRecordKey(entry.provider, entry.credentialId, entry.credentialCacheKey);
			const existing = latestByCredential.get(key);
			if (!existing || compareEntriesForRetention(entry, existing) < 0) {
				latestByCredential.set(key, entry);
			}
		}
		return [...latestByCredential.values()]
			.sort(compareEntriesForRetention)
			.slice(0, this.displayMaxEntries);
	}

	private haveEntriesChanged(
		previous: readonly CredentialScopedUsageCacheEntry[],
		next: readonly CredentialScopedUsageCacheEntry[],
	): boolean {
		if (previous.length !== next.length) {
			return true;
		}
		return JSON.stringify(previous) !== JSON.stringify(next);
	}

	private serialize(
		entries: readonly PersistedUsageCacheEntry[],
		displayEntries: readonly PersistedUsageDisplayCacheEntry[],
		generatedAt: number,
	): string {
		const payload: PersistedUsageCacheFile = {
			schemaVersion: USAGE_CACHE_SCHEMA_VERSION,
			generatedAt,
			maxEntries: this.maxEntries,
			maxDisplayEntries: this.displayMaxEntries,
			displayRetentionMs: this.displayRetentionMs,
			entries: [...entries].sort(compareEntriesForRetention),
			displayEntries: [...displayEntries].sort(compareEntriesForRetention),
		};
		return `${JSON.stringify(payload, null, 2)}\n`;
	}

	private async writeEntries(
		entries: readonly PersistedUsageCacheEntry[],
		displayEntries: readonly PersistedUsageDisplayCacheEntry[],
		generatedAt: number,
	): Promise<void> {
		try {
			const serialized = this.serialize(entries, displayEntries, generatedAt);
			await ensureParentDir(this.filePath);
			await writeTextSnapshotWithRetries({
				filePath: this.filePath,
				failureMessage: `Failed to persist usage cache snapshot to '${this.filePath}'.`,
				write: async () => {
					await writeFile(this.filePath, serialized, "utf-8");
					await chmod(this.filePath, 0o600);
				},
				isRetryableError: isRetryableFileAccessError,
				onRetry: ({ attempt, maxAttempts, reason, delayMs }) => {
					multiAuthDebugLogger.log("usage_cache_write_retry", {
						cachePath: this.filePath,
						attempt,
						maxAttempts,
						reason,
						delayMs,
					});
				},
				onRecovered: ({ attempt, maxAttempts }) => {
					multiAuthDebugLogger.log("usage_cache_write_recovered", {
						cachePath: this.filePath,
						attempt,
						maxAttempts,
					});
				},
				onError: ({ attempt, maxAttempts, error }) => {
					multiAuthDebugLogger.log("usage_cache_write_error", {
						cachePath: this.filePath,
						attempt,
						maxAttempts,
						error,
					});
				},
			});
		} catch (error: unknown) {
			multiAuthDebugLogger.log("usage_cache_write_failed", {
				cachePath: this.filePath,
				error: getErrorMessage(error),
			});
		}
	}
}
