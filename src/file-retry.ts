import { sleep } from "./async-utils.js";
import { toError } from "./auth-error-utils.js";

type RetryCallbackDetails = {
	attempt: number;
	maxAttempts: number;
	reason: string;
	delayMs: number;
};

type RecoveryCallbackDetails = {
	attempt: number;
	maxAttempts: number;
};

type ErrorCallbackDetails = {
	attempt: number;
	maxAttempts: number;
	error: string;
};

export type RetryableTextSnapshotReadOptions<T> = {
	filePath: string;
	failureMessage: string;
	read: () => Promise<string | undefined>;
	parse: (content: string | undefined) => T;
	resolveOnFinalEmpty: () => T;
	isRetryableError: (error: Error) => boolean;
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	onRetry?: (details: RetryCallbackDetails) => void;
	onRecovered?: (details: RecoveryCallbackDetails) => void;
	onError?: (details: ErrorCallbackDetails) => void;
};

export type RetryableTextSnapshotWriteOptions = {
	filePath: string;
	failureMessage: string;
	write: () => Promise<void>;
	isRetryableError: (error: Error) => boolean;
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	onRetry?: (details: RetryCallbackDetails) => void;
	onRecovered?: (details: RecoveryCallbackDetails) => void;
	onError?: (details: ErrorCallbackDetails) => void;
};

const DEFAULT_RETRY_ATTEMPTS = 6;
const DEFAULT_RETRY_BASE_DELAY_MS = 25;
const DEFAULT_RETRY_MAX_DELAY_MS = 200;
const RETRYABLE_FILE_ACCESS_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM", "UNKNOWN"]);

function getRetryDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
	return Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
}

export function isRetryableFileAccessError(error: Error): boolean {
	const maybeCode = (error as Error & { code?: unknown }).code;
	return typeof maybeCode === "string" && RETRYABLE_FILE_ACCESS_ERROR_CODES.has(maybeCode);
}

export async function readTextSnapshotWithRetries<T>(
	options: RetryableTextSnapshotReadOptions<T>,
): Promise<T> {
	const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS));
	const baseDelayMs = Math.max(1, Math.floor(options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS));
	const maxDelayMs = Math.max(baseDelayMs, Math.floor(options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS));
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const current = await options.read();
			if (typeof current === "string" && current.trim() === "") {
				if (attempt >= maxAttempts) {
					return options.resolveOnFinalEmpty();
				}
				const delayMs = getRetryDelayMs(attempt, baseDelayMs, maxDelayMs);
				options.onRetry?.({
					attempt,
					maxAttempts,
					reason: "empty-content",
					delayMs,
				});
				await sleep(delayMs);
				continue;
			}

			const parsed = options.parse(current);
			if (attempt > 1) {
				options.onRecovered?.({ attempt, maxAttempts });
			}
			return parsed;
		} catch (error) {
			const snapshotError = toError(error);
			lastError = snapshotError;
			if (attempt >= maxAttempts || !options.isRetryableError(snapshotError)) {
				options.onError?.({
					attempt,
					maxAttempts,
					error: snapshotError.message,
				});
				throw snapshotError;
			}

			const delayMs = getRetryDelayMs(attempt, baseDelayMs, maxDelayMs);
			options.onRetry?.({
				attempt,
				maxAttempts,
				reason: snapshotError.message,
				delayMs,
			});
			await sleep(delayMs);
		}
	}

	throw lastError ?? new Error(options.failureMessage);
}

export async function writeTextSnapshotWithRetries(
	options: RetryableTextSnapshotWriteOptions,
): Promise<void> {
	const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS));
	const baseDelayMs = Math.max(1, Math.floor(options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS));
	const maxDelayMs = Math.max(baseDelayMs, Math.floor(options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS));
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			await options.write();
			if (attempt > 1) {
				options.onRecovered?.({ attempt, maxAttempts });
			}
			return;
		} catch (error) {
			const writeError = toError(error);
			lastError = writeError;
			if (attempt >= maxAttempts || !options.isRetryableError(writeError)) {
				options.onError?.({
					attempt,
					maxAttempts,
					error: writeError.message,
				});
				throw writeError;
			}

			const delayMs = getRetryDelayMs(attempt, baseDelayMs, maxDelayMs);
			options.onRetry?.({
				attempt,
				maxAttempts,
				reason: writeError.message,
				delayMs,
			});
			await sleep(delayMs);
		}
	}

	throw lastError ?? new Error(options.failureMessage);
}
