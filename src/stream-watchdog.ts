import { multiAuthDebugLogger } from "./debug-logger.js";
import type { SupportedProviderId } from "./types.js";
import type { StreamTimeoutConfig } from "./types-stream-timeout.js";

export type StreamAttemptTimeoutKind = "attempt_timeout" | "idle_timeout";

const ABORT_MESSAGE_PATTERN = /\babort(?:ed|ing|ion)?\b/i;

export class StreamAttemptTimeoutError extends Error {
	readonly timeoutKind: StreamAttemptTimeoutKind;
	readonly timeoutMs: number;
	readonly providerId: SupportedProviderId;
	readonly credentialId: string;
	readonly modelId: string;

	constructor(options: {
		timeoutKind: StreamAttemptTimeoutKind;
		timeoutMs: number;
		providerId: SupportedProviderId;
		credentialId: string;
		modelId: string;
	}) {
		super(createStreamAttemptTimeoutMessage(options));
		this.name = "StreamAttemptTimeoutError";
		this.timeoutKind = options.timeoutKind;
		this.timeoutMs = options.timeoutMs;
		this.providerId = options.providerId;
		this.credentialId = options.credentialId;
		this.modelId = options.modelId;
	}
}

export interface StreamAttemptWatchdog {
	signal: AbortSignal;
	touch(): void;
	getTimeoutError(): StreamAttemptTimeoutError | null;
	isCallerAbort(error?: unknown): boolean;
	isCallerAbortMessage(message: string): boolean;
	dispose(): void;
}

function createStreamAttemptTimeoutMessage(options: {
	timeoutKind: StreamAttemptTimeoutKind;
	timeoutMs: number;
	providerId: SupportedProviderId;
	credentialId: string;
	modelId: string;
}): string {
	const reason =
		options.timeoutKind === "idle_timeout"
			? `stalled for ${options.timeoutMs}ms without receiving any stream event`
			: `exceeded the per-attempt deadline of ${options.timeoutMs}ms without completion`;
	return [
		`multi-auth stream timeout (${options.timeoutKind})`,
		`provider=${options.providerId}`,
		`credential=${options.credentialId}`,
		`model=${options.modelId}`,
		reason,
	].join(": ");
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
	if (timer !== null) {
		clearTimeout(timer);
	}
}

function getAbortSignalTimeoutError(signal: AbortSignal): StreamAttemptTimeoutError | null {
	return signal.reason instanceof StreamAttemptTimeoutError ? signal.reason : null;
}

export function isAbortError(error: unknown): boolean {
	if (error instanceof Error) {
		return error.name === "AbortError" || ABORT_MESSAGE_PATTERN.test(error.message);
	}
	if (typeof error === "string") {
		return ABORT_MESSAGE_PATTERN.test(error);
	}
	return false;
}

export function createStreamAttemptWatchdog(options: {
	providerId: SupportedProviderId;
	credentialId: string;
	modelId: string;
	timeoutConfig: StreamTimeoutConfig;
	parentSignal?: AbortSignal;
}): StreamAttemptWatchdog {
	const controller = new AbortController();
	let attemptTimer: ReturnType<typeof setTimeout> | null = null;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let timeoutError: StreamAttemptTimeoutError | null = null;

	const getResolvedTimeoutError = (): StreamAttemptTimeoutError | null => {
		return timeoutError ?? getAbortSignalTimeoutError(controller.signal);
	};

	const abortForTimeout = (timeoutKind: StreamAttemptTimeoutKind, timeoutMs: number): void => {
		if (getResolvedTimeoutError() || controller.signal.aborted) {
			return;
		}

		timeoutError = new StreamAttemptTimeoutError({
			timeoutKind,
			timeoutMs,
			providerId: options.providerId,
			credentialId: options.credentialId,
			modelId: options.modelId,
		});
		multiAuthDebugLogger.log("stream_attempt_timeout", {
			provider: options.providerId,
			credentialId: options.credentialId,
			modelId: options.modelId,
			timeoutKind,
			timeoutMs,
		});
		controller.abort(timeoutError);
	};

	const resetIdleTimer = (): void => {
		clearTimer(idleTimer);
		idleTimer = setTimeout(() => {
			abortForTimeout("idle_timeout", options.timeoutConfig.idleTimeoutMs);
		}, options.timeoutConfig.idleTimeoutMs);
	};

	const onParentAbort = (): void => {
		if (!controller.signal.aborted) {
			controller.abort();
		}
	};

	attemptTimer = setTimeout(() => {
		abortForTimeout("attempt_timeout", options.timeoutConfig.attemptTimeoutMs);
	}, options.timeoutConfig.attemptTimeoutMs);
	resetIdleTimer();

	if (options.parentSignal) {
		if (options.parentSignal.aborted) {
			onParentAbort();
		} else {
			options.parentSignal.addEventListener("abort", onParentAbort, { once: true });
		}
	}

	return {
		signal: controller.signal,
		touch(): void {
			if (timeoutError || controller.signal.aborted) {
				return;
			}
			resetIdleTimer();
		},
		getTimeoutError(): StreamAttemptTimeoutError | null {
			return getResolvedTimeoutError();
		},
		isCallerAbort(error?: unknown): boolean {
			if (!options.parentSignal?.aborted || getResolvedTimeoutError()) {
				return false;
			}
			if (error === undefined) {
				return true;
			}
			return isAbortError(error);
		},
		isCallerAbortMessage(message: string): boolean {
			return (
				Boolean(options.parentSignal?.aborted) &&
				getResolvedTimeoutError() === null &&
				isAbortError(message)
			);
		},
		dispose(): void {
			clearTimer(attemptTimer);
			clearTimer(idleTimer);
			if (options.parentSignal) {
				options.parentSignal.removeEventListener("abort", onParentAbort);
			}
		},
	};
}
