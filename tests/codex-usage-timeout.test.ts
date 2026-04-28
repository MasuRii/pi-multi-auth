import assert from "node:assert/strict";
import test from "node:test";

import { codexUsageProvider } from "../src/usage/codex.js";

function createAbortError(): Error {
	const error = new Error("The operation was aborted.");
	error.name = "AbortError";
	return error;
}

test("codex usage provider fails explicitly when usage fetch times out", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (signal?.aborted) {
				reject(createAbortError());
				return;
			}
			signal?.addEventListener(
				"abort",
				() => {
					reject(createAbortError());
				},
				{ once: true },
			);
		})) as typeof fetch;

	await assert.rejects(
		() => codexUsageProvider.fetchUsage!({ accessToken: "codex-timeout-test-token" }),
		/OpenAI Codex usage request timed out after 3000ms/,
	);
});
