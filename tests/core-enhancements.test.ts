import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { AccountManager } from "../src/account-manager.js";
import { AuthWriter } from "../src/auth-writer.js";
import {
	DEFAULT_MULTI_AUTH_CONFIG,
	resolveStateHistoryPersistencePaths,
	type MultiAuthExtensionConfig,
} from "../src/config.js";
import { multiAuthDebugLogger } from "../src/debug-logger.js";
import { classifyCredentialError } from "../src/error-classifier.js";
import { isRetryableFileAccessError, writeTextSnapshotWithRetries } from "../src/file-retry.js";
import { HealthScorer } from "../src/health-scorer.js";
import { OAuthRefreshScheduler, determineTokenExpiration, extractJwtExpiration } from "../src/oauth-refresh-scheduler.js";
import { PoolManager } from "../src/pool-manager.js";
import { createRotatingStreamWrapper } from "../src/provider.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { StreamAttemptTimeoutError } from "../src/stream-watchdog.js";
import { RateLimitHeaderParser } from "../src/rate-limit-headers.js";
import { createDefaultMultiAuthState, getProviderState, MultiAuthStorage } from "../src/storage.js";
import { OAuthRefreshFailureError } from "../src/types-oauth.js";
import { selectBestCredential } from "../src/balancer/weighted-selector.js";
import { UsageService } from "../src/usage/index.js";
import type { StoredAuthCredential } from "../src/types.js";
import type { UsageAuth, UsageSnapshot } from "../src/usage/types.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function createRetryableFileAccessError(message: string, code: string = "UNKNOWN"): Error {
	return Object.assign(new Error(message), { code });
}

function escapePowerShellSingleQuotedString(value: string): string {
	return value.replace(/'/g, "''");
}

async function withExclusiveWindowsFileLock<T>(
	filePath: string,
	holdMs: number,
	fn: () => Promise<T>,
): Promise<T> {
	const normalizedPath = filePath.replace(/\\/g, "/");
	const powerShellPath = escapePowerShellSingleQuotedString(normalizedPath);
	const script = [
		`$p='${powerShellPath}'`,
		"$fs=[System.IO.File]::Open($p,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)",
		"try {",
		`  Start-Sleep -Milliseconds ${Math.max(1, Math.floor(holdMs))}`,
		"} finally {",
		"  $fs.Close()",
		"}",
	].join("; ");
	const child = spawn("powershell", ["-NoProfile", "-Command", script], {
		stdio: "ignore",
	});

	try {
		await sleep(200);
		return await fn();
	} finally {
		if (child.exitCode === null) {
			child.kill();
			await once(child, "exit").catch(() => undefined);
		}
	}
}

function createBase64UrlJson(value: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(value), "utf-8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function createJwtWithExp(expiresAtSeconds: number): string {
	return [
		createBase64UrlJson({ alg: "none", typ: "JWT" }),
		createBase64UrlJson({ exp: expiresAtSeconds }),
		"signature",
	].join(".");
}

function cloneExtensionConfig(): MultiAuthExtensionConfig {
	return {
		...DEFAULT_MULTI_AUTH_CONFIG,
		excludeProviders: [...DEFAULT_MULTI_AUTH_CONFIG.excludeProviders],
		cascade: { ...DEFAULT_MULTI_AUTH_CONFIG.cascade },
		health: {
			...DEFAULT_MULTI_AUTH_CONFIG.health,
			weights: { ...DEFAULT_MULTI_AUTH_CONFIG.health.weights },
		},
		historyPersistence: { ...DEFAULT_MULTI_AUTH_CONFIG.historyPersistence },
		oauthRefresh: { ...DEFAULT_MULTI_AUTH_CONFIG.oauthRefresh },
		streamTimeouts: { ...DEFAULT_MULTI_AUTH_CONFIG.streamTimeouts },
	};
}

async function createAccountManagerHarness(
	t: TestContext,
	options: {
		providerId: string;
		authData: Record<string, unknown>;
		usageFetcher?: (auth: UsageAuth) => Promise<UsageSnapshot | null>;
		providerIds?: string[];
		modelsData?: { providers: Record<string, unknown> };
		extensionConfig?: MultiAuthExtensionConfig;
	},
): Promise<{
	accountManager: AccountManager;
	authPath: string;
	storagePath: string;
	modelsPath: string;
	debugDir: string;
}> {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-core-"));
	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const debugDir = join(tempRoot, "debug");

	await writeFile(authPath, JSON.stringify(options.authData, null, 2), "utf-8");
	await writeFile(
		modelsPath,
		JSON.stringify(options.modelsData ?? { providers: {} }, null, 2),
		"utf-8",
	);

	const authWriter = new AuthWriter(authPath);
	const extensionConfig = options.extensionConfig ?? cloneExtensionConfig();
	const storage = new MultiAuthStorage(storagePath, {
		debugDir,
		historyPersistence: extensionConfig.historyPersistence,
	});
	const usageService = new UsageService();
	if (options.usageFetcher) {
		usageService.register({
			id: options.providerId,
			displayName: options.providerId,
			fetchUsage: options.usageFetcher,
		});
	}
	const providerRegistry = new ProviderRegistry(
		authWriter,
		modelsPath,
		options.providerIds ?? [options.providerId],
	);
	const accountManager = new AccountManager(
		authWriter,
		storage,
		usageService,
		providerRegistry,
		undefined,
		extensionConfig,
	);

	t.after(async () => {
		accountManager.shutdown();
		await rm(tempRoot, { recursive: true, force: true });
	});

	return {
		accountManager,
		authPath,
		storagePath,
		modelsPath,
		debugDir,
	};
}

function createTestModel(provider: string): Model<"openai-completions"> {
	return {
		id: "glm-5",
		name: `GLM 5 (${provider})`,
		api: "openai-completions",
		provider,
		baseUrl: `https://${provider}.example.com/v1`,
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_000,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
	};
}

function createTestContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "Ping" }],
				timestamp: Date.now(),
			},
		],
	};
}

function createAssistantUsage(): AssistantMessage["usage"] {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function createAssistantMessageForTest(
	model: Model<"openai-completions">,
	content: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createAssistantUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function createStreamingBaseProvider(
	model: Model<"openai-completions">,
	options: {
		thinking: string;
		text: string;
	},
): {
	streamSimple: () => ReturnType<typeof createAssistantMessageEventStream>;
} {
	return {
		streamSimple: () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const thinkingBlock = {
					type: "thinking" as const,
					thinking: options.thinking,
					thinkingSignature: "reasoning",
				};
				const partialThinking = createAssistantMessageForTest(model, [thinkingBlock]);
				const partialText = createAssistantMessageForTest(model, [
					thinkingBlock,
					{ type: "text", text: options.text },
				]);
				const finalMessage = createAssistantMessageForTest(model, [
					thinkingBlock,
					{ type: "text", text: options.text },
				]);

				stream.push({ type: "start", partial: createAssistantMessageForTest(model, []) });
				stream.push({ type: "thinking_start", contentIndex: 0, partial: partialThinking });
				stream.push({
					type: "thinking_delta",
					contentIndex: 0,
					delta: options.thinking,
					partial: partialThinking,
				});
				stream.push({
					type: "thinking_end",
					contentIndex: 0,
					content: options.thinking,
					partial: partialThinking,
				});
				stream.push({ type: "text_start", contentIndex: 1, partial: partialText });
				stream.push({
					type: "text_delta",
					contentIndex: 1,
					delta: options.text,
					partial: partialText,
				});
				stream.push({
					type: "text_end",
					contentIndex: 1,
					content: options.text,
					partial: partialText,
				});
				stream.push({ type: "done", reason: "stop", message: finalMessage });
				stream.end();
			});
			return stream;
		},
	};
}

async function collectAssistantEvents(
	stream: ReturnType<ReturnType<typeof createRotatingStreamWrapper>>,
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function createAccountManagerStreamStub(options: { provider: string; onSuccess?: () => void }): AccountManager {
	return {
		acquireCredential: async () => ({
			provider: options.provider,
			credentialId: `${options.provider}-credential`,
			credential: { type: "api_key", key: "secret" },
			secret: "secret",
			index: 0,
		}),
		recordCredentialSuccess: async () => {
			options.onSuccess?.();
		},
		resolveFailoverTarget: async () => null,
		disableApiKeyCredential: async () => undefined,
		markTransientProviderError: async () => 0,
		markQuotaExceeded: async () => undefined,
	} as unknown as AccountManager;
}

function createRotatingTimeoutAccountManagerStub(options: {
	provider: string;
	credentials: Array<{ credentialId: string; secret: string }>;
	onAcquire?: (credentialId: string) => void;
	onSuccess?: (credentialId: string) => void;
	onTransientCooldown?: (credentialId: string, message: string) => void;
}): AccountManager {
	return {
		acquireCredential: async (
			_provider: string,
			requestOptions?: { excludedCredentialIds?: Set<string> },
		) => {
			const excludedCredentialIds = requestOptions?.excludedCredentialIds ?? new Set<string>();
			const selected = options.credentials.find(
				(candidate) => !excludedCredentialIds.has(candidate.credentialId),
			);
			if (!selected) {
				throw new Error(`No credential available for ${options.provider}.`);
			}
			options.onAcquire?.(selected.credentialId);
			return {
				provider: options.provider,
				credentialId: selected.credentialId,
				credential: { type: "api_key", key: selected.secret },
				secret: selected.secret,
				index: 0,
			};
		},
		recordCredentialSuccess: async (_provider: string, credentialId: string) => {
			options.onSuccess?.(credentialId);
		},
		resolveFailoverTarget: async () => null,
		disableApiKeyCredential: async () => undefined,
		markTransientProviderError: async (
			_provider: string,
			credentialId: string,
			message: string,
		) => {
			options.onTransientCooldown?.(credentialId, message);
			return 0;
		},
		markQuotaExceeded: async () => undefined,
	} as unknown as AccountManager;
}

function createAbortAwareTimeoutProvider(
	model: Model<"openai-completions">,
	options: {
		behaviorByApiKey: Record<string, "hang_silently" | "start_then_hang" | "success">;
		successText: string;
		abortMessage?: string;
		onCall?: (apiKey: string) => void;
		onAbort?: (apiKey: string, reason: unknown) => void;
	},
): {
	streamSimple: (
		model: Model<"openai-completions">,
		context: Context,
		streamOptions?: SimpleStreamOptions,
	) => ReturnType<typeof createAssistantMessageEventStream>;
} {
	return {
		streamSimple: (_model, _context, streamOptions) => {
			const apiKey = typeof streamOptions?.apiKey === "string" ? streamOptions.apiKey : "";
			options.onCall?.(apiKey);
			const behavior = options.behaviorByApiKey[apiKey] ?? "success";
			if (behavior === "success") {
				return createStreamingBaseProvider(model, {
					thinking: "I recovered after retrying the timed-out attempt.",
					text: options.successText,
				}).streamSimple();
			}

			const stream = createAssistantMessageEventStream();
			const emitAbortError = () => {
				queueMicrotask(() => {
					options.onAbort?.(apiKey, streamOptions?.signal?.reason);
					stream.push({
						type: "error",
						reason: "error",
						error: createAssistantMessageForTest(model, [], {
							stopReason: "error",
							errorMessage: options.abortMessage ?? "Provider request was aborted.",
						}),
					});
					stream.end();
				});
			};

			if (behavior === "start_then_hang") {
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessageForTest(model, []) });
				});
			}

			if (streamOptions?.signal?.aborted) {
				emitAbortError();
			} else {
				streamOptions?.signal?.addEventListener("abort", emitAbortError, { once: true });
			}
			return stream;
		},
	};
}

test("rotating stream wrapper suppresses malformed ollama thinking blocks", async () => {
	const model = createTestModel("ollama");
	const malformedThinking =
		"]])}}--])  ]-- }u-!!u--!】}--!}   ]] --} }]--U----%!^]]{u-- -}}{u--{}----]]}]]-}!----]------}]u]--}U----  ]--]--!}})}}--]".repeat(4);
	let successCount = 0;
	const wrapper = createRotatingStreamWrapper(
		"ollama",
		createAccountManagerStreamStub({
			provider: "ollama",
			onSuccess: () => {
				successCount += 1;
			},
		}),
		createStreamingBaseProvider(model, {
			thinking: malformedThinking,
			text: "Validated output.",
		}) as never,
	);

	const events = await collectAssistantEvents(wrapper(model, createTestContext(), { apiKey: "secret" }));
	assert.equal(
		events.some(
			(event) =>
				event.type === "thinking_start" ||
				event.type === "thinking_delta" ||
				event.type === "thinking_end",
		),
		false,
	);

	const doneEvent = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
	);
	assert.ok(doneEvent);
	assert.deepEqual(doneEvent.message.content.map((block) => block.type), ["text"]);
	assert.equal((doneEvent.message.content[0] as { text: string }).text, "Validated output.");
	assert.equal(successCount, 1);

	const malformedThinkingLeakedViaPartial = events.some((event) => {
		if (!("partial" in event) || !event.partial || !Array.isArray(event.partial.content)) {
			return false;
		}
		return event.partial.content.some((block) => block.type === "thinking");
	});
	assert.equal(malformedThinkingLeakedViaPartial, false);
});

test("rotating stream wrapper preserves readable ollama thinking blocks", async () => {
	const model = createTestModel("ollama");
	const wrapper = createRotatingStreamWrapper(
		"ollama",
		createAccountManagerStreamStub({ provider: "ollama" }),
		createStreamingBaseProvider(model, {
			thinking: "I should verify the implementation details before I answer.",
			text: "Validated output.",
		}) as never,
	);

	const events = await collectAssistantEvents(wrapper(model, createTestContext(), { apiKey: "secret" }));
	assert.equal(events.some((event) => event.type === "thinking_start"), true);
	assert.equal(events.some((event) => event.type === "thinking_delta"), true);
	assert.equal(events.some((event) => event.type === "thinking_end"), true);

	const doneEvent = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
	);
	assert.ok(doneEvent);
	assert.deepEqual(doneEvent.message.content.map((block) => block.type), ["thinking", "text"]);
});

test("rotating stream wrapper aborts silent attempts after idle timeout and rotates credentials", async () => {
	const model = createTestModel("openai");
	const acquiredCredentialIds: string[] = [];
	const succeededCredentialIds: string[] = [];
	const transientCooldowns: Array<{ credentialId: string; message: string }> = [];
	const callsByApiKey = new Map<string, number>();
	const wrapper = createRotatingStreamWrapper(
		"openai",
		createRotatingTimeoutAccountManagerStub({
			provider: "openai",
			credentials: [
				{ credentialId: "credential-a", secret: "secret-a" },
				{ credentialId: "credential-b", secret: "secret-b" },
			],
			onAcquire: (credentialId) => {
				acquiredCredentialIds.push(credentialId);
			},
			onSuccess: (credentialId) => {
				succeededCredentialIds.push(credentialId);
			},
			onTransientCooldown: (credentialId, message) => {
				transientCooldowns.push({ credentialId, message });
			},
		}),
		createAbortAwareTimeoutProvider(model, {
			behaviorByApiKey: {
				"secret-a": "hang_silently",
				"secret-b": "success",
			},
			successText: "Recovered after idle timeout.",
			onCall: (apiKey) => {
				callsByApiKey.set(apiKey, (callsByApiKey.get(apiKey) ?? 0) + 1);
			},
		}) as never,
		new Map(),
		{
			attemptTimeoutMs: 200,
			idleTimeoutMs: 20,
		},
	);

	const events = await collectAssistantEvents(wrapper(model, createTestContext(), { apiKey: "secret" }));
	const doneEvent = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
	);
	assert.ok(doneEvent);
	assert.equal(
		(doneEvent.message.content.find((block) => block.type === "text") as { text: string }).text,
		"Recovered after idle timeout.",
	);
	assert.deepEqual(succeededCredentialIds, ["credential-b"]);
	assert.equal(callsByApiKey.get("secret-a"), 3);
	assert.equal(callsByApiKey.get("secret-b"), 1);
	assert.deepEqual(acquiredCredentialIds, ["credential-a", "credential-b"]);
	assert.deepEqual(transientCooldowns, [
		{
			credentialId: "credential-a",
			message:
				"multi-auth stream timeout (idle_timeout): provider=openai: credential=credential-a: model=glm-5: stalled for 20ms without receiving any stream event",
		},
	]);
	assert.equal(events.some((event) => event.type === "error"), false);
});

test("rotating stream wrapper aborts started streams after the hard attempt timeout", async () => {
	const model = createTestModel("openai");
	const transientCooldowns: Array<{ credentialId: string; message: string }> = [];
	const callsByApiKey = new Map<string, number>();
	const wrapper = createRotatingStreamWrapper(
		"openai",
		createRotatingTimeoutAccountManagerStub({
			provider: "openai",
			credentials: [
				{ credentialId: "credential-a", secret: "secret-a" },
				{ credentialId: "credential-b", secret: "secret-b" },
			],
			onTransientCooldown: (credentialId, message) => {
				transientCooldowns.push({ credentialId, message });
			},
		}),
		createAbortAwareTimeoutProvider(model, {
			behaviorByApiKey: {
				"secret-a": "start_then_hang",
				"secret-b": "success",
			},
			successText: "Recovered after hard timeout.",
			onCall: (apiKey) => {
				callsByApiKey.set(apiKey, (callsByApiKey.get(apiKey) ?? 0) + 1);
			},
		}) as never,
		new Map(),
		{
			attemptTimeoutMs: 40,
			idleTimeoutMs: 200,
		},
	);

	const events = await collectAssistantEvents(wrapper(model, createTestContext(), { apiKey: "secret" }));
	const doneEvent = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
	);
	assert.ok(doneEvent);
	assert.equal(
		(doneEvent.message.content.find((block) => block.type === "text") as { text: string }).text,
		"Recovered after hard timeout.",
	);
	assert.equal(callsByApiKey.get("secret-a"), 3);
	assert.equal(callsByApiKey.get("secret-b"), 1);
	assert.deepEqual(transientCooldowns, [
		{
			credentialId: "credential-a",
			message:
				"multi-auth stream timeout (attempt_timeout): provider=openai: credential=credential-a: model=glm-5: exceeded the per-attempt deadline of 40ms without completion",
		},
	]);
	assert.equal(events.some((event) => event.type === "error"), false);
});

test("rotating stream wrapper preserves watchdog timeout identity across generic abort surfaces", async () => {
	const model = createTestModel("openai");
	const observedAbortReasons: unknown[] = [];
	const transientCooldowns: Array<{ credentialId: string; message: string }> = [];
	const wrapper = createRotatingStreamWrapper(
		"openai",
		createRotatingTimeoutAccountManagerStub({
			provider: "openai",
			credentials: [
				{ credentialId: "credential-a", secret: "secret-a" },
				{ credentialId: "credential-b", secret: "secret-b" },
			],
			onTransientCooldown: (credentialId, message) => {
				transientCooldowns.push({ credentialId, message });
			},
		}),
		createAbortAwareTimeoutProvider(model, {
			behaviorByApiKey: {
				"secret-a": "hang_silently",
				"secret-b": "success",
			},
			abortMessage: "Operation aborted",
			successText: "Recovered after generic abort timeout.",
			onAbort: (_apiKey, reason) => {
				observedAbortReasons.push(reason);
			},
		}) as never,
		new Map(),
		{
			attemptTimeoutMs: 200,
			idleTimeoutMs: 20,
		},
	);

	const events = await collectAssistantEvents(wrapper(model, createTestContext(), { apiKey: "secret" }));
	const doneEvent = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
	);
	assert.ok(doneEvent);
	assert.equal(
		(doneEvent.message.content.find((block) => block.type === "text") as { text: string }).text,
		"Recovered after generic abort timeout.",
	);
	assert.equal(observedAbortReasons.length, 3);
	for (const reason of observedAbortReasons) {
		if (!(reason instanceof StreamAttemptTimeoutError)) {
			assert.fail(`Expected StreamAttemptTimeoutError, received ${String(reason)}`);
		}
		assert.equal(reason.timeoutKind, "idle_timeout");
		assert.equal(
			reason.message,
			"multi-auth stream timeout (idle_timeout): provider=openai: credential=credential-a: model=glm-5: stalled for 20ms without receiving any stream event",
		);
	}
	assert.deepEqual(transientCooldowns, [
		{
			credentialId: "credential-a",
			message:
				"multi-auth stream timeout (idle_timeout): provider=openai: credential=credential-a: model=glm-5: stalled for 20ms without receiving any stream event",
		},
	]);
	assert.equal(events.some((event) => event.type === "error"), false);
});

test("rotating stream wrapper keeps caller initiated aborts terminal", async () => {
	const model = createTestModel("openai");
	const acquiredCredentialIds: string[] = [];
	const transientCooldowns: Array<{ credentialId: string; message: string }> = [];
	const callsByApiKey = new Map<string, number>();
	const abortController = new AbortController();
	abortController.abort();
	const wrapper = createRotatingStreamWrapper(
		"openai",
		createRotatingTimeoutAccountManagerStub({
			provider: "openai",
			credentials: [
				{ credentialId: "credential-a", secret: "secret-a" },
				{ credentialId: "credential-b", secret: "secret-b" },
			],
			onAcquire: (credentialId) => {
				acquiredCredentialIds.push(credentialId);
			},
			onTransientCooldown: (credentialId, message) => {
				transientCooldowns.push({ credentialId, message });
			},
		}),
		createAbortAwareTimeoutProvider(model, {
			behaviorByApiKey: {
				"secret-a": "hang_silently",
				"secret-b": "success",
			},
			abortMessage: "Operation aborted",
			successText: "This should never be emitted.",
			onCall: (apiKey) => {
				callsByApiKey.set(apiKey, (callsByApiKey.get(apiKey) ?? 0) + 1);
			},
		}) as never,
		new Map(),
		{
			attemptTimeoutMs: 200,
			idleTimeoutMs: 20,
		},
	);

	const events = await collectAssistantEvents(
		wrapper(model, createTestContext(), {
			apiKey: "secret",
			signal: abortController.signal,
		}),
	);
	assert.deepEqual(events, []);
	assert.deepEqual(acquiredCredentialIds, ["credential-a"]);
	assert.equal(callsByApiKey.get("secret-a"), 1);
	assert.equal(callsByApiKey.get("secret-b"), undefined);
	assert.deepEqual(transientCooldowns, []);
});

test("rate-limit header parser normalizes reset headers and retry metadata", () => {
	const parser = new RateLimitHeaderParser();
	const before = Date.now();
	const parsed = parser.parseHeaders(
		{
			"x-ratelimit-limit-requests": "100",
			"x-ratelimit-remaining-requests": "0",
			"x-ratelimit-reset-requests": "30",
		},
		"openai-codex",
	);
	const after = Date.now();

	assert.equal(parsed.limit, 100);
	assert.equal(parsed.remaining, 0);
	assert.equal(parsed.confidence, "high");
	assert.equal(parsed.source, "x-ratelimit-reset");
	assert.ok(parsed.resetAt !== null);
	assert.ok(parsed.resetAt! >= before + 29_000);
	assert.ok(parsed.resetAt! <= after + 31_000);
	assert.equal(parser.hasRemainingRequests(parsed), false);
});

test("account manager derives quota cooldowns from persisted rate-limit headers", async (t) => {
	const providerId = "rate-limit-provider";
	const resetAt = Date.now() + 90_000;
	const { accountManager, storagePath } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: { type: "api_key", key: "alpha" },
		},
		usageFetcher: async () => {
			const now = Date.now();
			return {
				timestamp: now,
				provider: providerId,
				planType: null,
				primary: null,
				secondary: null,
				credits: null,
				copilotQuota: null,
				updatedAt: now,
				rateLimitHeaders: {
					limit: 100,
					remaining: 0,
					resetAt,
					retryAfterSeconds: null,
					resetAtFormatted: new Date(resetAt).toISOString(),
					confidence: "high",
					source: "x-ratelimit-reset",
				},
				estimatedResetAt: resetAt,
				quotaClassification: "hourly",
			};
		},
	});

	await accountManager.ensureInitialized();
	const usage = await accountManager.getCredentialUsageSnapshot(providerId, providerId, {
		forceRefresh: true,
	});
	assert.equal(usage.error, null);

	const stored = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<string, { quotaExhaustedUntil?: Record<string, number> }>;
	};
	const exhaustedUntil = stored.providers[providerId]?.quotaExhaustedUntil?.[providerId];
	assert.ok(typeof exhaustedUntil === "number");
	assert.ok(exhaustedUntil >= resetAt - 1_000);
	assert.ok(exhaustedUntil <= resetAt + 1_000);
});

test("account manager batch deletes multiple credentials and re-syncs provider state", async (t) => {
	const providerId = "batch-delete-provider";
	const { accountManager, authPath, storagePath } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: { type: "api_key", key: "alpha" },
			[`${providerId}-1`]: { type: "api_key", key: "beta" },
			[`${providerId}-2`]: { type: "api_key", key: "gamma" },
		},
	});

	await accountManager.ensureInitialized();
	await accountManager.deleteCredentials(providerId, [providerId, `${providerId}-2`, providerId]);

	const authData = JSON.parse(await readFile(authPath, "utf-8")) as Record<string, unknown>;
	const storageData = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<string, { credentialIds: string[]; activeIndex: number }>;
	};
	const status = await accountManager.getProviderStatus(providerId);

	assert.deepEqual(Object.keys(authData).sort(), [`${providerId}-1`]);
	assert.deepEqual(storageData.providers[providerId]?.credentialIds, [`${providerId}-1`]);
	assert.equal(storageData.providers[providerId]?.activeIndex, 0);
	assert.deepEqual(status.credentials.map((credential) => credential.credentialId), [`${providerId}-1`]);
});

test("account manager validates batch deletion requests", async (t) => {
	const providerId = "batch-delete-validation-provider";
	const { accountManager } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: { type: "api_key", key: "alpha" },
		},
	});

	await accountManager.ensureInitialized();
	await assert.rejects(
		accountManager.deleteCredentials(providerId, []),
		/select at least one credential to delete/i,
	);
	await assert.rejects(
		accountManager.deleteCredentials(providerId, ["missing-credential"]),
		new RegExp(`provider ${providerId}`),
	);
});

test("account manager serves cached usage snapshots without re-reading auth state", async (t) => {
	const providerId = "cached-usage-provider";
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-cached-usage-"));
	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	let fetchCount = 0;

	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	await writeFile(
		authPath,
		JSON.stringify(
			{
				[providerId]: { type: "api_key", key: "alpha" },
			},
			null,
			2,
		),
		"utf-8",
	);
	await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");

	const authWriter = new AuthWriter(authPath);
	const storage = new MultiAuthStorage(storagePath);
	const usageService = new UsageService();
	usageService.register({
		id: providerId,
		displayName: providerId,
		fetchUsage: async () => {
			fetchCount += 1;
			const now = Date.now();
			return {
				timestamp: now,
				provider: providerId,
				planType: null,
				primary: null,
				secondary: null,
				credits: null,
				copilotQuota: null,
				updatedAt: now,
			};
		},
	});
	const providerRegistry = new ProviderRegistry(authWriter, modelsPath, [providerId]);
	const accountManager = new AccountManager(authWriter, storage, usageService, providerRegistry);

	t.after(() => {
		accountManager.shutdown();
	});

	const first = await accountManager.getCredentialUsageSnapshot(providerId, providerId, {
		maxAgeMs: 30_000,
	});
	assert.equal(first.error, null);
	assert.equal(first.fromCache, false);
	assert.equal(fetchCount, 1);

	Object.defineProperty(authWriter, "getCredential", {
		configurable: true,
		value: async (): Promise<StoredAuthCredential | undefined> => {
			throw new Error("cached usage should not trigger an auth credential read");
		},
	});

	const second = await accountManager.getCredentialUsageSnapshot(providerId, providerId, {
		maxAgeMs: 30_000,
	});
	assert.equal(second.error, null);
	assert.equal(second.fromCache, true);
	assert.equal(fetchCount, 1);
});

test("provider registry refreshes models metadata after models.json changes", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-provider-registry-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const authPath = join(tempRoot, "auth.json");
	const modelsPath = join(tempRoot, "models.json");
	await writeFile(authPath, JSON.stringify({}, null, 2), "utf-8");
	await writeFile(
		modelsPath,
		JSON.stringify(
			{
				providers: {
					alpha: {
						api: "openai",
						baseUrl: "https://example.test/v1",
						models: [{ id: "alpha-1", name: "Alpha 1" }],
					},
				},
			},
			null,
			2,
		),
		"utf-8",
	);

	const registry = new ProviderRegistry(new AuthWriter(authPath), modelsPath, []);
	const initialMetadata = await registry.resolveProviderRegistrationMetadata("alpha");
	assert.equal(initialMetadata?.baseUrl, "https://example.test/v1");
	assert.equal(initialMetadata?.models[0]?.id, "alpha-1");

	await sleep(1_100);
	await writeFile(
		modelsPath,
		JSON.stringify(
			{
				providers: {
					beta: {
						api: "openai",
						baseUrl: "https://example.test/v2",
						models: [{ id: "beta-1", name: "Beta 1" }],
					},
				},
			},
			null,
			2,
		),
		"utf-8",
	);

	const providers = await registry.discoverProviderIds();
	const removedMetadata = await registry.resolveProviderRegistrationMetadata("alpha");
	const refreshedMetadata = await registry.resolveProviderRegistrationMetadata("beta");

	assert.deepEqual(providers, ["beta"]);
	assert.equal(removedMetadata, null);
	assert.equal(refreshedMetadata?.baseUrl, "https://example.test/v2");
	assert.equal(refreshedMetadata?.models[0]?.id, "beta-1");
});

test("cascade retry state persists across account-manager restarts and clears on success", async (t) => {
	const providerId = "cascade-provider";
	const harness = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: { type: "api_key", key: "alpha" },
			[`${providerId}-1`]: { type: "api_key", key: "beta" },
			[`${providerId}-2`]: { type: "api_key", key: "gamma" },
		},
	});
	const historyPaths = resolveStateHistoryPersistencePaths(
		DEFAULT_MULTI_AUTH_CONFIG.historyPersistence,
		harness.debugDir,
	);

	await harness.accountManager.ensureInitialized();
	const initialSelection = await harness.accountManager.acquireCredential(providerId);
	await harness.accountManager.markTransientProviderError(
		providerId,
		initialSelection.credentialId,
		"server busy",
	);

	const stateAfterFailure = JSON.parse(await readFile(harness.storagePath, "utf-8")) as {
		providers: Record<
			string,
			{
				cascadeState?: Record<
					string,
					{ active?: { attemptCount: number; cascadePath: Array<{ credentialId: string }> } }
				>;
			}
		>;
	};
	assert.equal(
		stateAfterFailure.providers[providerId]?.cascadeState?.[providerId]?.active?.attemptCount,
		1,
	);
	assert.equal(
		stateAfterFailure.providers[providerId]?.cascadeState?.[providerId]?.active?.cascadePath[0]
			?.credentialId,
		initialSelection.credentialId,
	);

	const restarted = new AccountManager(
		new AuthWriter(harness.authPath),
		new MultiAuthStorage(harness.storagePath, {
			debugDir: harness.debugDir,
			historyPersistence: DEFAULT_MULTI_AUTH_CONFIG.historyPersistence,
		}),
		new UsageService(),
		new ProviderRegistry(new AuthWriter(harness.authPath), harness.modelsPath, [providerId]),
		undefined,
		cloneExtensionConfig(),
	);
	t.after(() => {
		restarted.shutdown();
	});

	await restarted.ensureInitialized();
	const restartedSelection = await restarted.acquireCredential(providerId);
	assert.notEqual(restartedSelection.credentialId, initialSelection.credentialId);

	await restarted.recordCredentialSuccess(providerId, restartedSelection.credentialId, 25);
	const stateAfterSuccess = JSON.parse(await readFile(harness.storagePath, "utf-8")) as {
		providers: Record<string, { cascadeState?: Record<string, { active?: unknown }> }>;
	};
	const cascadeHistory = JSON.parse(await readFile(historyPaths.cascadePath, "utf-8")) as {
		providers?: Record<string, Record<string, Array<{ attemptCount: number }>>>;
	};
	assert.equal(stateAfterSuccess.providers[providerId]?.cascadeState?.[providerId]?.active, undefined);
	assert.equal(stateAfterSuccess.providers[providerId]?.cascadeState, undefined);
	assert.equal(cascadeHistory.providers?.[providerId]?.[providerId]?.[0]?.attemptCount, 1);
});

test("account manager applies configured cascade history retention", async (t) => {
	const providerId = "cascade-config-provider";
	const extensionConfig = cloneExtensionConfig();
	extensionConfig.cascade.maxHistoryEntries = 1;
	const { accountManager, storagePath, debugDir } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: { type: "api_key", key: "alpha" },
		},
		extensionConfig,
	});
	const historyPaths = resolveStateHistoryPersistencePaths(extensionConfig.historyPersistence, debugDir);

	await accountManager.ensureInitialized();
	await accountManager.recordCredentialFailure(providerId, providerId, 25, "provider_transient", "burst 1");
	await accountManager.recordCredentialSuccess(providerId, providerId, 25);
	await accountManager.recordCredentialFailure(providerId, providerId, 25, "provider_transient", "burst 2");
	await accountManager.recordCredentialSuccess(providerId, providerId, 25);

	const stored = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<string, { cascadeState?: Record<string, unknown> }>;
	};
	const cascadeHistory = JSON.parse(await readFile(historyPaths.cascadePath, "utf-8")) as {
		providers?: Record<
			string,
			Record<string, Array<{ cascadePath: Array<{ errorMessage: string }> }>>
		>;
	};
	const history = cascadeHistory.providers?.[providerId]?.[providerId] ?? [];
	assert.equal(stored.providers[providerId]?.cascadeState, undefined);
	assert.equal(history.length, 1);
	assert.equal(history[0]?.cascadePath[0]?.errorMessage, "burst 2");
});

test("health scoring favors reliable credentials in weighted selection", () => {
	const scorer = new HealthScorer({
		minRequests: 2,
		windowSize: 10,
		maxLatencyMs: 1_000,
		uptimeWindowMs: 60_000,
	});

	scorer.recordSuccess("healthy", 50);
	scorer.recordSuccess("healthy", 75);
	scorer.recordFailure("unhealthy", 900, "provider_transient");
	scorer.recordFailure("unhealthy", 950, "provider_transient");

	const healthyScore = scorer.calculateScore("healthy");
	const unhealthyScore = scorer.calculateScore("unhealthy");
	assert.ok(healthyScore.score > unhealthyScore.score);

	const selected = selectBestCredential(
		{
			providerId: "health-provider",
			excludedIds: [],
			requestingSessionId: "session-1",
		},
		{
			credentialIds: ["healthy", "unhealthy"],
			usageCount: { healthy: 0, unhealthy: 0 },
			balancerState: {
				weights: { healthy: 0, unhealthy: 0 },
				cooldowns: {},
				activeRequests: { healthy: 0, unhealthy: 0 },
				lastUsedAt: { healthy: 0, unhealthy: 0 },
				healthScores: {
					healthy: healthyScore.score,
					unhealthy: 0,
				},
			},
		},
		{
			waitTimeoutMs: 1_000,
			defaultCooldownMs: 1_000,
			maxConcurrentPerKey: 1,
			tolerance: 0,
		},
	);

	assert.equal(selected, "healthy");
});

test("account manager applies configured health scoring thresholds", async (t) => {
	const providerId = "health-config-provider";
	const extensionConfig = cloneExtensionConfig();
	extensionConfig.health.minRequests = 1;
	extensionConfig.health.maxLatencyMs = 1_000;
	const { accountManager, storagePath, debugDir } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: { type: "api_key", key: "alpha" },
		},
		extensionConfig,
	});
	const historyPaths = resolveStateHistoryPersistencePaths(extensionConfig.historyPersistence, debugDir);

	await accountManager.ensureInitialized();
	await accountManager.recordCredentialSuccess(providerId, providerId, 50);

	const stored = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<
			string,
			{
				healthState?: {
					scores?: Record<string, { score: number; isStale: boolean }>;
					history?: Record<string, unknown>;
					configHash?: string;
				};
			}
		>;
	};
	const healthHistory = JSON.parse(await readFile(historyPaths.healthPath, "utf-8")) as {
		providers?: Record<
			string,
			Record<string, { requests?: Array<{ success: boolean }> }>
		>;
	};
	const score = stored.providers[providerId]?.healthState?.scores?.[providerId];
	assert.ok(score);
	assert.ok(score.score > 0.6);
	assert.equal(score.isStale, false);
	assert.equal(stored.providers[providerId]?.healthState?.history, undefined);
	assert.equal(healthHistory.providers?.[providerId]?.[providerId]?.requests?.length, 1);
	assert.equal(healthHistory.providers?.[providerId]?.[providerId]?.requests?.[0]?.success, true);
	assert.match(stored.providers[providerId]?.healthState?.configHash ?? "", /"minRequests":1/);
});

test("storage hydrates embedded telemetry history and migrates it into extracted history files", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-history-migration-"));
	const storagePath = join(tempRoot, "multi-auth.json");
	const debugDir = join(tempRoot, "debug");
	const historyPaths = resolveStateHistoryPersistencePaths(
		DEFAULT_MULTI_AUTH_CONFIG.historyPersistence,
		debugDir,
	);

	try {
		const providerId = "migration-provider";
		const state = createDefaultMultiAuthState([providerId]);
		const providerState = getProviderState(state, providerId);
		providerState.credentialIds = [providerId];
		providerState.healthState = {
			scores: {
				[providerId]: {
					credentialId: providerId,
					score: 0.82,
					calculatedAt: 1_717_000_000_000,
					components: {
						successRate: 1,
						latencyFactor: 0.9,
						uptimeFactor: 1,
						recoveryFactor: 0.8,
					},
					isStale: false,
				},
			},
			history: {
				[providerId]: {
					credentialId: providerId,
					requests: [{ timestamp: 1_717_000_000_000, success: true, latencyMs: 42 }],
					cooldowns: [],
					lastScore: 0.82,
					lastCalculatedAt: 1_717_000_000_000,
				},
			},
			configHash: '{"windowSize":100}',
		};
		providerState.cascadeState = {
			[providerId]: {
				history: [
					{
						cascadeId: "cascade-1",
						cascadePath: [
							{
								providerId,
								credentialId: providerId,
								attemptedAt: 1_717_000_000_100,
								errorKind: "provider_transient",
								errorMessage: "legacy embedded history",
								recoveryAction: "none",
							},
						],
						attemptCount: 1,
						startedAt: 1_717_000_000_100,
						lastAttemptAt: 1_717_000_000_100,
						nextRetryAt: 1_717_000_001_100,
						isActive: false,
					},
				],
			},
		};
		await writeFile(storagePath, JSON.stringify(state, null, 2), "utf-8");

		const storage = new MultiAuthStorage(storagePath, {
			debugDir,
			historyPersistence: DEFAULT_MULTI_AUTH_CONFIG.historyPersistence,
		});
		const hydrated = await storage.read();
		assert.equal(
			hydrated.providers[providerId]?.healthState?.history?.[providerId]?.requests.length,
			1,
		);
		assert.equal(
			hydrated.providers[providerId]?.cascadeState?.[providerId]?.history?.[0]?.attemptCount,
			1,
		);

		await storage.withLock((current) => {
			const currentProviderState = getProviderState(current, providerId);
			currentProviderState.lastUsedAt[providerId] = 1_717_000_002_000;
			return { result: undefined, next: current };
		});

		const compactState = JSON.parse(await readFile(storagePath, "utf-8")) as {
			providers: Record<
				string,
				{
					healthState?: { history?: Record<string, unknown> };
					cascadeState?: Record<string, { history?: Array<unknown> }>;
				}
			>;
		};
		const extractedHealthHistory = JSON.parse(await readFile(historyPaths.healthPath, "utf-8")) as {
			providers?: Record<string, Record<string, { requests?: Array<unknown> }>>;
		};
		const extractedCascadeHistory = JSON.parse(await readFile(historyPaths.cascadePath, "utf-8")) as {
			providers?: Record<string, Record<string, Array<{ cascadePath: Array<{ errorMessage: string }> }>>>;
		};
		const rehydrated = await storage.read();

		assert.equal(compactState.providers[providerId]?.healthState?.history, undefined);
		assert.equal(compactState.providers[providerId]?.cascadeState, undefined);
		assert.equal(
			extractedHealthHistory.providers?.[providerId]?.[providerId]?.requests?.length,
			1,
		);
		assert.equal(
			extractedCascadeHistory.providers?.[providerId]?.[providerId]?.[0]?.cascadePath[0]
				?.errorMessage,
			"legacy embedded history",
		);
		assert.equal(
			rehydrated.providers[providerId]?.healthState?.history?.[providerId]?.requests.length,
			1,
		);
		assert.equal(
			rehydrated.providers[providerId]?.cascadeState?.[providerId]?.history?.[0]?.attemptCount,
			1,
		);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("pool manager stays opt-in and selects the highest-priority healthy pool", () => {
	const disabledManager = new PoolManager();
	assert.equal(disabledManager.isEnabled(), false);
	assert.equal(
		disabledManager.selectPool(["cred-a"], {
			scores: {
				"cred-a": {
					credentialId: "cred-a",
					score: 0.9,
					calculatedAt: Date.now(),
					components: {
						successRate: 1,
						latencyFactor: 1,
						uptimeFactor: 1,
						recoveryFactor: 1,
					},
					isStale: false,
				},
			},
		}),
		null,
	);

	const enabledManager = new PoolManager({
		enablePools: true,
		failoverStrategy: "priority",
		preferHealthyWithinPool: true,
		pools: [
			{
				poolId: "secondary",
				credentialIds: ["cred-c"],
				priority: 2,
				poolMode: "round-robin",
			},
			{
				poolId: "primary",
				credentialIds: ["cred-a", "cred-b"],
				priority: 1,
				poolMode: "usage-based",
			},
		],
	});

	const selection = enabledManager.selectPool(["cred-a", "cred-b", "cred-c"], {
		scores: {
			"cred-a": {
				credentialId: "cred-a",
				score: 0.2,
				calculatedAt: Date.now(),
				components: {
					successRate: 0.2,
					latencyFactor: 0.2,
					uptimeFactor: 0.2,
					recoveryFactor: 0.2,
				},
				isStale: false,
			},
			"cred-b": {
				credentialId: "cred-b",
				score: 0.9,
				calculatedAt: Date.now(),
				components: {
					successRate: 0.9,
					latencyFactor: 0.9,
					uptimeFactor: 0.9,
					recoveryFactor: 0.9,
				},
				isStale: false,
			},
			"cred-c": {
				credentialId: "cred-c",
				score: 1,
				calculatedAt: Date.now(),
				components: {
					successRate: 1,
					latencyFactor: 1,
					uptimeFactor: 1,
					recoveryFactor: 1,
				},
				isStale: false,
			},
		},
	});
	assert.equal(selection?.pool.poolId, "primary");
	assert.deepEqual(selection?.availableCredentialIds, ["cred-b", "cred-a"]);
});

test("account manager honors configured pools before default rotation", async (t) => {
	const providerId = "pool-provider";
	const { accountManager, storagePath } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: { type: "api_key", key: "alpha" },
			[`${providerId}-1`]: { type: "api_key", key: "beta" },
			[`${providerId}-2`]: { type: "api_key", key: "gamma" },
		},
	});

	await accountManager.ensureInitialized();
	const storage = new MultiAuthStorage(storagePath);
	await storage.withLock((state) => {
		const providerState = getProviderState(state, providerId);
		providerState.pools = [
			{
				poolId: "primary",
				credentialIds: [`${providerId}-2`],
				priority: 1,
				poolMode: "round-robin",
			},
			{
				poolId: "secondary",
				credentialIds: [providerId, `${providerId}-1`],
				priority: 2,
				poolMode: "round-robin",
			},
		];
		providerState.poolState = { poolIndex: 0 };
		return { result: undefined, next: state };
	});

	const selected = await accountManager.acquireCredential(providerId);
	assert.equal(selected.credentialId, `${providerId}-2`);

	const stored = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<string, { poolState?: { activePoolId?: string } }>;
	};
	assert.equal(stored.providers[providerId]?.poolState?.activePoolId, "primary");
});

test("account manager rotates across pools when provider pool failover strategy is configured", async (t) => {
	const providerId = "pool-strategy-provider";
	const { accountManager, storagePath } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: { type: "api_key", key: "alpha" },
			[`${providerId}-1`]: { type: "api_key", key: "beta" },
		},
	});

	await accountManager.ensureInitialized();
	const storage = new MultiAuthStorage(storagePath);
	await storage.withLock((state) => {
		const providerState = getProviderState(state, providerId);
		providerState.rotationMode = "usage-based";
		providerState.pools = [
			{
				poolId: "primary",
				credentialIds: [providerId],
				priority: 1,
				poolMode: "round-robin",
			},
			{
				poolId: "secondary",
				credentialIds: [`${providerId}-1`],
				priority: 2,
				poolMode: "round-robin",
			},
		];
		providerState.poolConfig = {
			enablePools: true,
			failoverStrategy: "round-robin",
			preferHealthyWithinPool: true,
		};
		providerState.poolState = { poolIndex: 0 };
		return { result: undefined, next: state };
	});

	const first = await accountManager.acquireCredential(providerId);
	const second = await accountManager.acquireCredential(providerId);
	assert.equal(first.credentialId, providerId);
	assert.equal(second.credentialId, `${providerId}-1`);

	const stored = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<string, { poolState?: { activePoolId?: string; poolIndex?: number } }>;
	};
	assert.equal(stored.providers[providerId]?.poolState?.activePoolId, "secondary");
	assert.equal(stored.providers[providerId]?.poolState?.poolIndex, 0);
});

test("account manager advances round-robin within a pool even when provider rotation differs", async (t) => {
	const providerId = "pool-mode-provider";
	const { accountManager, storagePath } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: { type: "api_key", key: "alpha" },
			[`${providerId}-1`]: { type: "api_key", key: "beta" },
		},
	});

	await accountManager.ensureInitialized();
	const storage = new MultiAuthStorage(storagePath);
	await storage.withLock((state) => {
		const providerState = getProviderState(state, providerId);
		providerState.rotationMode = "usage-based";
		providerState.pools = [
			{
				poolId: "shared",
				credentialIds: [providerId, `${providerId}-1`],
				priority: 1,
				poolMode: "round-robin",
			},
		];
		providerState.poolConfig = {
			enablePools: true,
			failoverStrategy: "priority",
			preferHealthyWithinPool: true,
		};
		providerState.poolState = { poolIndex: 0 };
		providerState.activeIndex = 0;
		return { result: undefined, next: state };
	});

	const first = await accountManager.acquireCredential(providerId);
	const second = await accountManager.acquireCredential(providerId);
	assert.equal(first.credentialId, providerId);
	assert.equal(second.credentialId, `${providerId}-1`);
});

test("storage validates and persists explicit provider pool configuration", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-pool-config-"));
	const storagePath = join(tempRoot, "multi-auth.json");

	try {
		await writeFile(
			storagePath,
			JSON.stringify(
				{
					version: 1,
					providers: {
						valid: {
							credentialIds: ["valid"],
							activeIndex: 0,
							rotationMode: "round-robin",
							lastUsedAt: {},
							usageCount: {},
							quotaErrorCount: {},
							quotaExhaustedUntil: {},
							lastQuotaError: {},
							lastTransientError: {},
							transientErrorCount: {},
							weeklyQuotaAttempts: {},
							friendlyNames: {},
							disabledCredentials: {},
							pools: [
								{
									poolId: "primary",
									credentialIds: ["valid"],
									priority: 1,
									poolMode: "round-robin",
								},
							],
							poolConfig: {
								enablePools: false,
								failoverStrategy: "health-based",
								preferHealthyWithinPool: false,
							},
						},
						invalid: {
							credentialIds: ["invalid"],
							activeIndex: 0,
							rotationMode: "round-robin",
							lastUsedAt: {},
							usageCount: {},
							quotaErrorCount: {},
							quotaExhaustedUntil: {},
							lastQuotaError: {},
							lastTransientError: {},
							transientErrorCount: {},
							weeklyQuotaAttempts: {},
							friendlyNames: {},
							disabledCredentials: {},
							pools: [
								{
									poolId: "primary",
									credentialIds: ["invalid"],
									priority: 1,
									poolMode: "round-robin",
								},
							],
							poolConfig: {
								enablePools: "no",
								failoverStrategy: "invalid",
								preferHealthyWithinPool: "no",
							},
						},
					},
					ui: { hiddenProviders: [] },
				},
				null,
				2,
			),
			"utf-8",
		);

		const storage = new MultiAuthStorage(storagePath);
		const state = await storage.read();
		assert.deepEqual(state.providers.valid?.poolConfig, {
			enablePools: false,
			failoverStrategy: "health-based",
			preferHealthyWithinPool: false,
		});
		assert.equal(state.providers.invalid?.poolConfig, undefined);

		await storage.withLock((nextState) => {
			const providerState = getProviderState(nextState, "valid");
			providerState.poolConfig = {
				enablePools: true,
				failoverStrategy: "round-robin",
				preferHealthyWithinPool: false,
			};
			return { result: undefined, next: nextState };
		});

		const persisted = JSON.parse(await readFile(storagePath, "utf-8")) as {
			providers: Record<string, { poolConfig?: Record<string, unknown> }>;
		};
		assert.deepEqual(persisted.providers.valid?.poolConfig, {
			enablePools: true,
			failoverStrategy: "round-robin",
			preferHealthyWithinPool: false,
		});
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("storage reuses cached snapshots for provider-scoped reads and credential lookup", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-provider-cache-"));
	const storagePath = join(tempRoot, "multi-auth.json");

	try {
		const state = createDefaultMultiAuthState(["provider-a", "provider-b"]);
		const providerAState = getProviderState(state, "provider-a");
		providerAState.credentialIds = ["provider-a", "provider-a-1"];
		providerAState.usageCount["provider-a"] = 7;
		const providerBState = getProviderState(state, "provider-b");
		providerBState.credentialIds = ["provider-b"];
		await writeFile(storagePath, JSON.stringify(state, null, 2), "utf-8");

		const storage = new MultiAuthStorage(storagePath);
		const firstProviderRead = await storage.readProviderState("provider-a");
		firstProviderRead.credentialIds.push("mutated-locally");
		const secondProviderRead = await storage.readProviderState("provider-a");
		const resolvedProvider = await storage.findProviderForCredential("provider-a-1");
		const metrics = storage.getMetrics();

		assert.deepEqual(secondProviderRead.credentialIds, ["provider-a", "provider-a-1"]);
		assert.equal(secondProviderRead.usageCount["provider-a"], 7);
		assert.equal(resolvedProvider, "provider-a");
		assert.equal(metrics.cacheMissCount, 1);
		assert.equal(metrics.cacheHitCount, 2);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("account manager resolves deterministic failover chains with mapped models", async (t) => {
	const sourceProvider = "chain-source";
	const targetProvider = "chain-target";
	const mappedModelId = "target-model";
	const { accountManager, storagePath } = await createAccountManagerHarness(t, {
		providerId: sourceProvider,
		providerIds: [sourceProvider, targetProvider],
		authData: {
			[sourceProvider]: { type: "api_key", key: "alpha" },
			[targetProvider]: { type: "api_key", key: "beta" },
		},
		modelsData: {
			providers: {
				[sourceProvider]: {
					api: "openai",
					baseUrl: "https://example.invalid/source",
					models: [{ id: "source-model", name: "Source Model" }],
				},
				[targetProvider]: {
					api: "anthropic",
					baseUrl: "https://example.invalid/target",
					models: [{ id: mappedModelId, name: "Target Model" }],
				},
			},
		},
	});

	await accountManager.ensureInitialized();
	const storage = new MultiAuthStorage(storagePath);
	await storage.withLock((state) => {
		const providerState = getProviderState(state, sourceProvider);
		providerState.chains = [
			{
				chainId: "primary-chain",
				providers: [
					{ providerId: sourceProvider },
					{
						providerId: targetProvider,
						modelMapping: { "source-model": mappedModelId },
					},
				],
				maxAttemptsPerProvider: 1,
				failoverTriggers: ["quota", "authentication"],
			},
		];
		return { result: undefined, next: state };
	});

	const failover = await accountManager.resolveFailoverTarget(
		sourceProvider,
		"quota",
		"source-model",
	);
	assert.deepEqual(failover, {
		chainId: "primary-chain",
			providerId: targetProvider,
			modelId: mappedModelId,
			api: "anthropic",
			position: 1,
			isLastProvider: true,
	});

	await accountManager.recordCredentialSuccess(targetProvider, targetProvider, 10);
	const stored = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<string, { activeChain?: unknown }>;
	};
	assert.equal(stored.providers[sourceProvider]?.activeChain, undefined);
});

test("richer quota classification drives cooldown duration and persisted quota state", async (t) => {
	const providerId = "quota-provider";
	const { accountManager, storagePath } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: { type: "api_key", key: "alpha" },
		},
	});

	await accountManager.ensureInitialized();
	const classification = classifyCredentialError("Daily limit reached. Try again tomorrow.");
	assert.equal(classification.quotaClassification, "daily");
	assert.ok((classification.recommendedCooldownMs ?? 0) >= 24 * 60 * 60_000);

	await accountManager.markQuotaExceeded(providerId, providerId, {
		errorMessage: "Daily limit reached. Try again tomorrow.",
		quotaClassification: classification.quotaClassification,
		recommendedCooldownMs: classification.recommendedCooldownMs,
	});

	const stored = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<
			string,
			{
				quotaExhaustedUntil?: Record<string, number>;
				quotaStates?: Record<string, { classification: string; recoveryAction: { action: string } }>;
			}
		>;
	};
	const exhaustedUntil = stored.providers[providerId]?.quotaExhaustedUntil?.[providerId] ?? 0;
	assert.ok(exhaustedUntil > Date.now() + (23 * 60 * 60_000));
	assert.equal(stored.providers[providerId]?.quotaStates?.[providerId]?.classification, "daily");
	assert.equal(stored.providers[providerId]?.quotaStates?.[providerId]?.recoveryAction.action, "wait");
});

test("oauth helpers prefer JWT expiration and scheduler refreshes credentials pre-emptively", async () => {
	const expiresAtSeconds = Math.floor((Date.now() + 60_000) / 1_000);
	const jwt = createJwtWithExp(expiresAtSeconds);
	const jwtExpiration = extractJwtExpiration(jwt);
	assert.equal(jwtExpiration, expiresAtSeconds * 1_000);

	const expiration = determineTokenExpiration(jwt, Date.now() + 120_000, undefined);
	assert.equal(expiration.source, "jwt_exp");
	assert.equal(expiration.expiresAt, expiresAtSeconds * 1_000);

	const refreshCalls: Array<{ credentialId: string; providerId: string }> = [];
	const scheduler = new OAuthRefreshScheduler(
		async (credentialId, providerId) => {
			refreshCalls.push({ credentialId, providerId });
			return Date.now() + 5_000;
		},
		{
			enabled: true,
			safetyWindowMs: 50,
			minRefreshWindowMs: 10,
			checkIntervalMs: 10,
			maxConcurrentRefreshes: 1,
		},
	);

	scheduler.start();
	scheduler.scheduleRefresh("oauth-credential", "oauth-provider", Date.now() + 40);
	await sleep(50);
	scheduler.stop();

	assert.equal(refreshCalls.length, 1);
	assert.deepEqual(refreshCalls[0], {
		credentialId: "oauth-credential",
		providerId: "oauth-provider",
	});
});

test("oauth refresh scheduler defers excess due work until concurrency is available", async () => {
	const refreshCalls: string[] = [];
	let releaseFirstRefresh: (() => void) | undefined;
	const firstRefreshReleased = new Promise<void>((resolve) => {
		releaseFirstRefresh = resolve;
	});
	const scheduler = new OAuthRefreshScheduler(
		async (credentialId) => {
			refreshCalls.push(credentialId);
			if (credentialId === "oauth-a") {
				await firstRefreshReleased;
			}
			return Date.now() + 5_000;
		},
		{
			enabled: true,
			safetyWindowMs: 1,
			minRefreshWindowMs: 10,
			checkIntervalMs: 10,
			maxConcurrentRefreshes: 1,
		},
	);

	scheduler.start();
	scheduler.scheduleRefresh("oauth-a", "oauth-provider", Date.now() + 2);
	await sleep(15);
	scheduler.scheduleRefresh("oauth-b", "oauth-provider", Date.now() + 2);
	await sleep(15);

	assert.deepEqual(refreshCalls, ["oauth-a"]);

	releaseFirstRefresh?.();
	await sleep(40);
	scheduler.stop();

	assert.deepEqual(refreshCalls, ["oauth-a", "oauth-b"]);
});

test("oauth refresh scheduler stops retrying after permanent refresh failures", async () => {
	let attempts = 0;
	const scheduler = new OAuthRefreshScheduler(
		async () => {
			attempts += 1;
			throw new OAuthRefreshFailureError("permanent refresh failure", {
				providerId: "openai-codex",
				credentialId: "oauth-a",
				permanent: true,
				source: "extension",
			});
		},
		{
			enabled: true,
			safetyWindowMs: 1,
			minRefreshWindowMs: 10,
			checkIntervalMs: 10,
			maxConcurrentRefreshes: 1,
		},
	);

	scheduler.start();
	scheduler.scheduleRefresh("oauth-a", "openai-codex", Date.now() + 2);
	await sleep(30);
	await sleep(30);
	scheduler.stop();

	assert.equal(attempts, 1);
	assert.equal(scheduler.getPendingRefreshes().size, 0);
});

test("account manager handles permanent Codex refresh failures without console noise", async (t) => {
	const providerId = "openai-codex";
	const expiredJwt = createJwtWithExp(Math.floor((Date.now() - 60_000) / 1_000));
	const { accountManager, storagePath } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: {
				type: "oauth",
				access: expiredJwt,
				refresh: "codex-refresh-token",
				expires: Date.now() - 60_000,
				accountId: "acct_test_123",
			},
		},
	});

	const originalFetch = globalThis.fetch;
	const originalConsoleError = console.error;
	const originalDebugLog = multiAuthDebugLogger.log.bind(multiAuthDebugLogger);
	const debugEntries: Array<{ event: string; payload: Record<string, unknown> }> = [];
	let consoleErrorCalls = 0;

	t.after(() => {
		globalThis.fetch = originalFetch;
		console.error = originalConsoleError;
		multiAuthDebugLogger.log = originalDebugLog;
	});

	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				error: "invalid_grant",
				error_description: "Refresh token has expired or was revoked.",
			}),
			{
				status: 400,
				headers: { "Content-Type": "application/json" },
			},
		);
	console.error = () => {
		consoleErrorCalls += 1;
	};
	multiAuthDebugLogger.log = (event, payload = {}) => {
		debugEntries.push({ event, payload: { ...payload } });
	};

	await assert.rejects(
		() => accountManager.refreshCredential(providerId, providerId),
		/invalid_grant/,
	);

	const stored = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<
			string,
			{
				disabledCredentials?: Record<string, { error: string; disabledAt: number }>;
				quotaExhaustedUntil?: Record<string, number>;
				lastQuotaError?: Record<string, string>;
				oauthRefreshScheduled?: Record<string, number>;
			}
		>;
	};
	const disabledEntry = stored.providers[providerId]?.disabledCredentials?.[providerId];
	const quotaExhaustedUntil = stored.providers[providerId]?.quotaExhaustedUntil?.[providerId];
	const lastQuotaError = stored.providers[providerId]?.lastQuotaError?.[providerId];
	const refreshFailureLog = debugEntries.find((entry) => entry.event === "oauth_refresh_failed");
	const cooldownLog = debugEntries.find(
		(entry) => entry.event === "oauth_refresh_codex_cooldown",
	);

	// OpenAI Codex permanent refresh failures no longer auto-disable.
	// Instead, they set a long cooldown (24h) so users can manually re-login.
	assert.equal(consoleErrorCalls, 0);
	assert.ok(refreshFailureLog);
	assert.equal(refreshFailureLog?.payload.permanent, true);
	assert.equal(refreshFailureLog?.payload.status, 400);
	assert.equal(refreshFailureLog?.payload.errorCode, "invalid_grant");
	assert.ok(cooldownLog);
	assert.ok(typeof quotaExhaustedUntil === "number");
	assert.ok(quotaExhaustedUntil > Date.now());
	assert.match(lastQuotaError ?? "", /invalid_grant/);
	// Credential should NOT be disabled for openai-codex
	assert.equal(disabledEntry, undefined);
	assert.deepEqual(stored.providers[providerId]?.oauthRefreshScheduled ?? {}, {});
});

test("account manager persists scheduled oauth refresh timestamps for oauth credentials", async (t) => {
	const providerId = "openai-codex";
	const expiresAt = Date.now() + 10 * 60_000;
	const jwt = createJwtWithExp(Math.floor(expiresAt / 1_000));
	const { accountManager, storagePath } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: {
				type: "oauth",
				access: jwt,
				refresh: "refresh-token",
				expires: expiresAt,
			},
		},
	});

	await accountManager.ensureInitialized();

	const stored = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<string, { oauthRefreshScheduled?: Record<string, number> }>;
	};
	const scheduledAt = stored.providers[providerId]?.oauthRefreshScheduled?.[providerId];
	assert.ok(typeof scheduledAt === "number");
	assert.ok(scheduledAt < expiresAt);
	assert.ok(scheduledAt > Date.now());
});

test("account manager disables background oauth scheduling when configured", async (t) => {
	const providerId = "openai-codex";
	const expiresAt = Date.now() + 10 * 60_000;
	const jwt = createJwtWithExp(Math.floor(expiresAt / 1_000));
	const extensionConfig = cloneExtensionConfig();
	extensionConfig.oauthRefresh.enabled = false;
	const { accountManager, storagePath } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: {
				type: "oauth",
				access: jwt,
				refresh: "refresh-token",
				expires: expiresAt,
			},
		},
		extensionConfig,
	});

	await accountManager.ensureInitialized();

	const stored = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<string, { oauthRefreshScheduled?: Record<string, number> }>;
	};
	assert.deepEqual(stored.providers[providerId]?.oauthRefreshScheduled ?? {}, {});
});

test("account manager getProviderStatus avoids rewriting unchanged multi-auth state", async (t) => {
	const providerId = "status-provider";
	const { accountManager, storagePath } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: { type: "api_key", key: "alpha" },
		},
	});

	await accountManager.ensureInitialized();
	const beforeMtimeMs = (await stat(storagePath)).mtimeMs;
	await sleep(25);

	const status = await accountManager.getProviderStatus(providerId);
	const afterMtimeMs = (await stat(storagePath)).mtimeMs;

	assert.equal(status.credentials.length, 1);
	assert.equal(status.credentials[0]?.credentialId, providerId);
	assert.equal(afterMtimeMs, beforeMtimeMs);
});

test("auth writer skips no-op persistence when adding an existing API key credential", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-auth-writer-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const authPath = join(tempRoot, "auth.json");
	await writeFile(
		authPath,
		JSON.stringify({ duplicate: { type: "api_key", key: "alpha" } }, null, 2),
		"utf-8",
	);

	const authWriter = new AuthWriter(authPath);
	const beforeMtimeMs = (await stat(authPath)).mtimeMs;
	await sleep(25);

	const result = await authWriter.setApiKeyCredentialAsBackup("duplicate", "alpha");
	const afterMtimeMs = (await stat(authPath)).mtimeMs;

	assert.equal(result.didAddCredential, false);
	assert.equal(result.duplicateOfCredentialId, "duplicate");
	assert.equal(afterMtimeMs, beforeMtimeMs);
});

test("multi-auth storage retries transient Windows file-open errors while reading", async (t) => {
	if (process.platform !== "win32") {
		t.skip("Windows-specific file locking behavior");
		return;
	}

	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-storage-read-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	const storagePath = join(tempRoot, "multi-auth.json");
	await writeFile(
		storagePath,
		JSON.stringify(createDefaultMultiAuthState(["openai-codex"]), null, 2),
		"utf-8",
	);
	const storage = new MultiAuthStorage(storagePath);
	const startedAt = Date.now();

	const state = await withExclusiveWindowsFileLock(storagePath, 450, async () => storage.read());
	const elapsedMs = Date.now() - startedAt;

	assert.equal(state.version, 1);
	assert.ok(elapsedMs >= 150);
	assert.deepEqual(Object.keys(state.providers), ["openai-codex"]);
});

test("file retry helper retries transient file-access errors during persistence", async () => {
	let attempts = 0;

	await writeTextSnapshotWithRetries({
		filePath: "C:/virtual/multi-auth.json",
		failureMessage: "write failed",
		write: async () => {
			attempts += 1;
			if (attempts < 3) {
				throw createRetryableFileAccessError(
					"UNKNOWN: unknown error, open 'C:/virtual/multi-auth.json'",
				);
			}
		},
		isRetryableError: isRetryableFileAccessError,
	});

	assert.equal(attempts, 3);
});
