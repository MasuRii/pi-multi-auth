import { createAbortError, throwFixedAbortErrorIfAborted } from "./auth-error-utils.js";

export interface FetchWithTimeoutOptions {
	fetchImplementation?: typeof fetch;
	timeoutMs: number;
	signal?: AbortSignal;
	abortMessage?: string;
	timeoutMessage?: string;
}

export function sleep(ms: number): Promise<void> {
	if (ms <= 0) {
		return Promise.resolve();
	}

	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export async function fetchWithTimeout(
	input: RequestInfo | URL,
	init: RequestInit,
	options: FetchWithTimeoutOptions,
): Promise<Response> {
	const { fetchImplementation = fetch, timeoutMs, signal, abortMessage, timeoutMessage } = options;
	if (abortMessage) {
		throwFixedAbortErrorIfAborted(signal, abortMessage);
	}

	const controller = new AbortController();
	if (signal?.aborted) {
		controller.abort(signal.reason);
	}
	let timedOut = false;
	let externallyAborted = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = (): void => {
		externallyAborted = true;
		controller.abort(signal?.reason);
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		return await fetchImplementation(input, {
			...init,
			signal: controller.signal,
		});
	} catch (error) {
		if (externallyAborted && abortMessage) {
			throw createAbortError(abortMessage);
		}
		if (timedOut && timeoutMessage) {
			throw new Error(timeoutMessage);
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}
