import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { AccountManager } from "../src/account-manager.js";
import {
	formatOAuthRefreshFailureSummary,
	getErrorMessage,
	inferOAuthRefreshFailureMetadata,
	isRecord,
} from "../src/auth-error-utils.js";
import { AsyncBufferedLogWriter } from "../src/async-buffered-log-writer.js";
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
import { refreshOAuthCredential, registerOAuthProvider, resetOAuthProviders } from "../src/oauth-compat.js";
import { registerClineOAuthProvider } from "../src/oauth-cline.js";
import { OAuthRefreshScheduler, determineTokenExpiration, extractJwtExpiration } from "../src/oauth-refresh-scheduler.js";
import {
	PI_AGENT_ROUTER_DELEGATED_API_KEY_ENV,
	PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID_ENV,
	PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID_ENV,
	PI_AGENT_ROUTER_SUBAGENT_ENV,
} from "../src/runtime-context.js";
import { PoolManager } from "../src/pool-manager.js";
import { createRotatingStreamWrapper } from "../src/provider.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { RateLimitHeaderParser } from "../src/rate-limit-headers.js";
import { createDefaultMultiAuthState, getProviderState, MultiAuthStorage } from "../src/storage.js";
import { OAuthRefreshFailureError } from "../src/types-oauth.js";
import { selectBestCredential } from "../src/balancer/weighted-selector.js";
import { UsageService } from "../src/usage/index.js";
import type { StoredAuthCredential } from "../src/types.js";
import type { UsageAuth, UsageSnapshot } from "../src/usage/types.js";

const PI_AGENT_ROUTER_ENV_KEYS = [
	PI_AGENT_ROUTER_SUBAGENT_ENV,
	PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID_ENV,
	PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID_ENV,
	PI_AGENT_ROUTER_DELEGATED_API_KEY_ENV,
] as const;

type PiAgentRouterEnvKey = (typeof PI_AGENT_ROUTER_ENV_KEYS)[number];

function capturePiAgentRouterEnv(): Record<PiAgentRouterEnvKey, string | undefined> {
	return Object.fromEntries(
		PI_AGENT_ROUTER_ENV_KEYS.map((key) => [key, process.env[key]]),
	) as Record<PiAgentRouterEnvKey, string | undefined>;
}

function restorePiAgentRouterEnv(env: Record<PiAgentRouterEnvKey, string | undefined>): void {
	for (const key of PI_AGENT_ROUTER_ENV_KEYS) {
		const value = env[key];
		if (typeof value === "string") {
			process.env[key] = value;
		} else {
			delete process.env[key];
		}
	}
}

function clearPiAgentRouterEnv(): void {
	for (const key of PI_AGENT_ROUTER_ENV_KEYS) {
		delete process.env[key];
	}
}

const piAgentRouterEnvStack: Array<Record<PiAgentRouterEnvKey, string | undefined>> = [];

test.beforeEach(() => {
	piAgentRouterEnvStack.push(capturePiAgentRouterEnv());
	clearPiAgentRouterEnv();
});

test.afterEach(() => {
	const originalEnv = piAgentRouterEnvStack.pop();
	if (originalEnv) {
		restorePiAgentRouterEnv(originalEnv);
	}
});

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

function createCodexIdentityJwt(options: {
	expiresAtSeconds: number;
	accountId: string;
	accountUserId: string;
	email: string;
}): string {
	return [
		createBase64UrlJson({ alg: "none", typ: "JWT" }),
		createBase64UrlJson({
			exp: options.expiresAtSeconds,
			"https://api.openai.com/auth": {
				chatgpt_account_id: options.accountId,
				chatgpt_account_user_id: options.accountUserId,
			},
			"https://api.openai.com/profile": {
				email: options.email,
			},
		}),
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
		oauthRefresh: {
			...DEFAULT_MULTI_AUTH_CONFIG.oauthRefresh,
			excludedProviders: [...DEFAULT_MULTI_AUTH_CONFIG.oauthRefresh.excludedProviders],
		},
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
	const usageService = new UsageService(undefined, undefined, undefined, undefined, { persistentCache: false });
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
		await accountManager.shutdown();
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
	model: Model<Api>,
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

function createEmptyCompletionThenSuccessProvider(
	model: Model<"openai-completions">,
	options: {
		text: string;
		onCall?: (callNumber: number) => void;
	},
): {
	streamSimple: () => ReturnType<typeof createAssistantMessageEventStream>;
} {
	let callCount = 0;

	return {
		streamSimple: () => {
			const stream = createAssistantMessageEventStream();
			const currentCall = callCount;
			callCount += 1;
			options.onCall?.(callCount);
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessageForTest(model, []) });
				if (currentCall === 0) {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessageForTest(model, [], {
							usage: {
								...createAssistantUsage(),
								output: 0,
								totalTokens: 1,
							},
							responseId: "empty-completion-response",
						}),
					});
					stream.end();
					return;
				}

				const partialText = createAssistantMessageForTest(model, [
					{ type: "text", text: options.text },
				]);
				stream.push({ type: "text_start", contentIndex: 0, partial: partialText });
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta: options.text,
					partial: partialText,
				});
				stream.push({
					type: "text_end",
					contentIndex: 0,
					content: options.text,
					partial: partialText,
				});
				stream.push({ type: "done", reason: "stop", message: partialText });
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

test("rotating stream wrapper redacts request auth debug secrets", async (t) => {
	const provider = "openai-codex";
	const model = createTestModel(provider);
	const secret = "sensitive-oauth-token-prefix-1234567890";
	const capturedLogs: Array<{ event: string; payload: Record<string, unknown> }> = [];
	const originalLog = multiAuthDebugLogger.log.bind(multiAuthDebugLogger);
	multiAuthDebugLogger.log = (event: string, payload: Record<string, unknown> = {}) => {
		capturedLogs.push({ event, payload });
	};
	t.after(() => {
		multiAuthDebugLogger.log = originalLog;
	});

	const wrapper = createRotatingStreamWrapper(
		provider,
		{
			listProviderCredentialIds: async () => [`${provider}-credential`],
			acquireCredential: async () => ({
				provider,
				credentialId: `${provider}-credential`,
				credential: {
					type: "oauth",
					access: secret,
					refresh: "refresh-token",
					expires: Date.now() + 60_000,
				},
				secret,
				index: 0,
			}),
			recordCredentialSuccess: async () => undefined,
			resolveFailoverTarget: async () => null,
			disableApiKeyCredential: async () => undefined,
			markTransientProviderError: async () => 0,
			markQuotaExceeded: async () => undefined,
		} as unknown as AccountManager,
		createStreamingBaseProvider(model, {
			thinking: "No secret should be logged.",
			text: "Validated output.",
		}) as never,
	);

	await collectAssistantEvents(wrapper(model, createTestContext(), { apiKey: "caller-key" }));

	const authLog = capturedLogs.find((entry) => entry.event === "stream_request_auth");
	assert.ok(authLog);
	assert.equal(Object.hasOwn(authLog.payload, "secretPrefix"), false);
	assert.equal(Object.hasOwn(authLog.payload, "secretStartsWithWorkos"), false);
	assert.equal(authLog.payload.secretKind, "oauth");
	assert.equal(authLog.payload.hasSecret, true);
	assert.equal(JSON.stringify(authLog.payload).includes(secret.slice(0, 12)), false);
});

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

for (const providerId of ["ollama", "vivgrid"] as const) {
	test(`rotating stream wrapper retries empty ${providerId} stop completions before succeeding`, async () => {
		const model = createTestModel(providerId);
		let successCount = 0;
		let providerCallCount = 0;
		const wrapper = createRotatingStreamWrapper(
			providerId,
			createAccountManagerStreamStub({
				provider: providerId,
				onSuccess: () => {
					successCount += 1;
				},
			}),
			createEmptyCompletionThenSuccessProvider(model, {
				text: "Recovered output.",
				onCall: () => {
					providerCallCount += 1;
				},
			}) as never,
		);

		const events = await collectAssistantEvents(
			wrapper(model, createTestContext(), { apiKey: "secret" }),
		);
		const doneEvents = events.filter(
			(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
		);

		assert.equal(providerCallCount, 2);
		assert.equal(successCount, 1);
		assert.equal(doneEvents.length, 1);
		assert.deepEqual(doneEvents[0].message.content.map((block) => block.type), ["text"]);
		assert.equal((doneEvents[0].message.content[0] as { text: string }).text, "Recovered output.");
		assert.equal(
			events.some((event) => event.type === "done" && event.message.content.length === 0),
			false,
		);
		assert.equal(events.some((event) => event.type === "error"), false);
	});
}

test("provider registry restores Cline OAuth capability after OAuth registry resets", () => {
	resetOAuthProviders();
	const registry = new ProviderRegistry();

	assert.equal(registry.getProviderCapabilities("cline").supportsOAuth, true);
	assert.ok(registry.listAvailableOAuthProviders().some((provider) => provider.provider === "cline"));

	resetOAuthProviders();
});

test("Cline stream wrapper attaches Cline client headers to model requests", async () => {
	const model = createTestModel("cline");
	const observedHeaders: Record<string, string | undefined> = {};
	const wrapper = createRotatingStreamWrapper(
		"cline",
		{
			acquireCredential: async () => ({
				provider: "cline",
				credentialId: "cline",
				credential: { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 },
				secret: "workos:token",
				index: 0,
			}),
			recordCredentialSuccess: async () => undefined,
			resolveFailoverTarget: async () => null,
			disableApiKeyCredential: async () => undefined,
			markTransientProviderError: async () => 0,
			markQuotaExceeded: async () => undefined,
		} as unknown as AccountManager,
		{
			streamSimple: (
				_model: Model<"openai-completions">,
				_context: Context,
				options?: SimpleStreamOptions,
			) => {
				const headers = options?.headers as Record<string, string> | undefined;
				observedHeaders["User-Agent"] = headers?.["User-Agent"];
				observedHeaders["X-CLIENT-TYPE"] = headers?.["X-CLIENT-TYPE"];
				observedHeaders["X-TASK-ID"] = headers?.["X-TASK-ID"];
				return createStreamingBaseProvider(model, { thinking: "headers", text: "ok" }).streamSimple();
			},
		} as never,
	);

	const events = await collectAssistantEvents(wrapper(model, createTestContext(), { apiKey: "unused" }));

	assert.equal(events.some((event) => event.type === "done"), true);
	assert.match(observedHeaders["User-Agent"] ?? "", /^Cline\//);
	assert.equal(observedHeaders["X-CLIENT-TYPE"], "VSCode Extension");
	assert.ok(observedHeaders["X-TASK-ID"] && observedHeaders["X-TASK-ID"].length > 0);
});


test("Kilo stream wrapper attaches Kilo editor headers to model requests", async () => {
	const model = createTestModel("kilo");
	const observedHeaders: Record<string, string | undefined> = {};
	const wrapper = createRotatingStreamWrapper(
		"kilo",
		{
			acquireCredential: async () => ({
				provider: "kilo",
				credentialId: "kilo",
				credential: { type: "oauth", access: "kilo-token", refresh: "kilo-token", expires: Date.now() + 3_600_000 },
				secret: "kilo-token",
				index: 0,
			}),
			recordCredentialSuccess: async () => undefined,
			resolveFailoverTarget: async () => null,
			disableApiKeyCredential: async () => undefined,
			markTransientProviderError: async () => 0,
			markQuotaExceeded: async () => undefined,
		} as unknown as AccountManager,
		{
			streamSimple: (
				_model: Model<"openai-completions">,
				_context: Context,
				options?: SimpleStreamOptions,
			) => {
				const headers = options?.headers as Record<string, string> | undefined;
				observedHeaders["X-KILOCODE-EDITORNAME"] = headers?.["X-KILOCODE-EDITORNAME"];
				observedHeaders["X-EXISTING"] = headers?.["X-EXISTING"];
				return createStreamingBaseProvider(model, { thinking: "headers", text: "ok" }).streamSimple();
			},
		} as never,
	);

	const events = await collectAssistantEvents(
		wrapper(model, createTestContext(), { apiKey: "stale", headers: { "X-EXISTING": "kept" } }),
	);

	assert.equal(events.some((event) => event.type === "done"), true);
	assert.equal(observedHeaders["X-KILOCODE-EDITORNAME"], "Pi");
	assert.equal(observedHeaders["X-EXISTING"], "kept");
});

test("OpenAI Codex invalidated authentication tokens are disabled while rotating through the full eligible pool", async () => {
	const model: Model<"openai-codex-responses"> = {
		id: "gpt-5.5",
		name: "GPT 5.5",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
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
	const workingToken = "paid-codex-token";
	const credentialIds = Array.from({ length: 12 }, (_, index) =>
		index === 11 ? "codex-paid" : `codex-invalidated-${index + 1}`,
	);
	const tokenByCredentialId = new Map<string, string>(
		credentialIds.map((credentialId) => [
			credentialId,
			credentialId === "codex-paid"
				? workingToken
				: `invalidated-codex-token-${credentialId}`,
		]),
	);
	const expectedApiKeys = credentialIds.map((credentialId) => {
		const token = tokenByCredentialId.get(credentialId);
		assert.ok(token);
		return token;
	});
	const acquiredCredentialIds: string[] = [];
	const disabledCredentialIds: string[] = [];
	const disabledErrorKinds: string[] = [];
	const quotaCredentialIds: string[] = [];
	const requestedModelIds: Array<string | undefined> = [];
	const apiKeysSeen: string[] = [];

	const wrapper = createRotatingStreamWrapper(
		"openai-codex",
		{
			listProviderCredentialIds: async () => credentialIds,
			acquireCredential: async (
				_provider: string,
				requestOptions?: { excludedCredentialIds?: Set<string>; modelId?: string },
			) => {
				requestedModelIds.push(requestOptions?.modelId);
				const excludedCredentialIds = requestOptions?.excludedCredentialIds ?? new Set<string>();
				const credentialId = credentialIds.find(
					(candidate) => !excludedCredentialIds.has(candidate),
				);
				if (!credentialId) {
					throw new Error("No Codex credential remained available for GPT 5.5.");
				}
				const token = tokenByCredentialId.get(credentialId);
				assert.ok(token);
				acquiredCredentialIds.push(credentialId);
				return {
					provider: "openai-codex",
					credentialId,
					credential: {
						type: "oauth",
						access: token,
						refresh: `refresh-${credentialId}`,
						expires: Date.now() + 3_600_000,
						provider: "openai-codex",
					},
					secret: token,
					index: credentialIds.indexOf(credentialId),
				};
			},
			recordCredentialSuccess: async () => undefined,
			resolveFailoverTarget: async () => null,
			disableApiKeyCredential: async (
				_provider: string,
				credentialId: string,
				_errorMessage: string,
				errorKind: string,
			) => {
				disabledCredentialIds.push(credentialId);
				disabledErrorKinds.push(errorKind);
			},
			markTransientProviderError: async () => 0,
			markQuotaExceeded: async (_provider: string, credentialId: string) => {
				quotaCredentialIds.push(credentialId);
			},
		} as unknown as AccountManager,
		{
			streamSimple: (
				_model: Model<"openai-codex-responses">,
				_context: Context,
				options?: SimpleStreamOptions,
			) => {
				const apiKey = typeof options?.apiKey === "string" ? options.apiKey : "";
				apiKeysSeen.push(apiKey);
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (apiKey !== workingToken) {
						stream.push({
							type: "error",
							reason: "error",
							error: createAssistantMessageForTest(model, [], {
								stopReason: "error",
								errorMessage:
									"Encountered invalidated oauth token for user, failing request",
							}),
						});
						stream.end();
						return;
					}

					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessageForTest(model, [
							{ type: "text", text: "Codex rotation recovered." },
						]),
					});
					stream.end();
				});
				return stream;
			},
		} as never,
	);

	const events = await collectAssistantEvents(wrapper(model, createTestContext(), { apiKey: "[REDACTED]" }));

	assert.deepEqual(acquiredCredentialIds, credentialIds);
	assert.deepEqual(requestedModelIds, credentialIds.map(() => "gpt-5.5"));
	assert.deepEqual(apiKeysSeen, expectedApiKeys);
	assert.deepEqual(disabledCredentialIds, credentialIds.slice(0, -1));
	assert.deepEqual(disabledErrorKinds, credentialIds.slice(0, -1).map(() => "authentication"));
	assert.deepEqual(quotaCredentialIds, []);
	assert.equal(events.some((event) => event.type === "error"), false);
	const doneEvent = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
	);
	assert.ok(doneEvent);
	assert.deepEqual(doneEvent.message.content, [
		{ type: "text", text: "Codex rotation recovered." },
	]);
});

test("OpenAI Codex model access errors rotate and record model incompatibility", async () => {
	const model: Model<"openai-completions"> = {
		...createTestModel("openai-codex"),
		id: "gpt-5.4",
		name: "GPT 5.4",
	};
	const credentials = [
		{ credentialId: "codex-free", secret: "free-codex-token" },
		{ credentialId: "codex-plus", secret: "plus-codex-token" },
	];
	const acquiredCredentialIds: string[] = [];
	const modelIncompatibilities: Array<{ credentialId: string; modelId: string; message: string }> = [];

	const wrapper = createRotatingStreamWrapper(
		"openai-codex",
		{
			acquireCredential: async (
				_provider: string,
				requestOptions?: { excludedCredentialIds?: Set<string>; modelId?: string },
			) => {
				assert.equal(requestOptions?.modelId, "gpt-5.4");
				const excludedCredentialIds = requestOptions?.excludedCredentialIds ?? new Set<string>();
				const selected = credentials.find(
					(credential) => !excludedCredentialIds.has(credential.credentialId),
				);
				if (!selected) {
					throw new Error("No Codex credential remained available.");
				}
				acquiredCredentialIds.push(selected.credentialId);
				return {
					provider: "openai-codex",
					credentialId: selected.credentialId,
					credential: { type: "api_key", key: selected.secret },
					secret: selected.secret,
					index: credentials.indexOf(selected),
				};
			},
			recordCredentialSuccess: async () => undefined,
			resolveFailoverTarget: async () => null,
			disableApiKeyCredential: async () => undefined,
			markCredentialModelIncompatible: async (
				_provider: string,
				credentialId: string,
				modelId: string,
				message: string,
			) => {
				modelIncompatibilities.push({ credentialId, modelId, message });
				return Date.now() + 60_000;
			},
			markTransientProviderError: async () => 0,
			markQuotaExceeded: async () => undefined,
		} as unknown as AccountManager,
		{
			streamSimple: (
				_model: Model<"openai-completions">,
				_context: Context,
				options?: SimpleStreamOptions,
			) => {
				const apiKey = typeof options?.apiKey === "string" ? options.apiKey : "";
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (apiKey === "free-codex-token") {
						stream.push({
							type: "error",
							reason: "error",
							error: createAssistantMessageForTest(model, [], {
								stopReason: "error",
								errorMessage:
									"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
							}),
						});
						stream.end();
						return;
					}

					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessageForTest(model, [
							{ type: "text", text: "paid-codex-account-ok" },
						]),
					});
					stream.end();
				});
				return stream;
			},
		} as never,
	);

	const events = await collectAssistantEvents(wrapper(model, createTestContext(), { apiKey: "[REDACTED]" }));

	assert.deepEqual(acquiredCredentialIds, ["codex-free", "codex-plus"]);
	assert.equal(modelIncompatibilities.length, 1);
	assert.equal(modelIncompatibilities[0].credentialId, "codex-free");
	assert.equal(modelIncompatibilities[0].modelId, "gpt-5.4");
	assert.match(modelIncompatibilities[0].message, /not supported/i);
	assert.equal(events.some((event) => event.type === "error"), false);
	const doneEvent = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
	);
	assert.ok(doneEvent);
	assert.deepEqual(doneEvent.message.content, [
		{ type: "text", text: "paid-codex-account-ok" },
	]);
});

test("OpenAI Codex token_revoked OAuth errors classify as disabling authentication failures", () => {
	const classification = classifyCredentialError(
		"Encountered invalidated oauth token for user, failing request (code: token_revoked, status: 401)",
		{ providerId: "openai-codex", modelId: "gpt-5.4" },
	);

	assert.equal(classification.kind, "authentication");
	assert.equal(classification.shouldRotateCredential, true);
	assert.equal(classification.shouldDisableCredential, true);
	assert.equal(classification.shouldApplyCooldown, false);
});

test("delegated credential overrides pin the delegated credential through account-manager selection", async (t) => {
	const model = createTestModel("cline");
	const delegatedCredentialId = "cline";
	const acquiredCredentialSelections: string[][] = [];

	process.env[PI_AGENT_ROUTER_SUBAGENT_ENV] = "1";
	process.env[PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID_ENV] = "cline";
	process.env[PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID_ENV] = delegatedCredentialId;
	process.env[PI_AGENT_ROUTER_DELEGATED_API_KEY_ENV] = "workos:stale-token";

	const wrapper = createRotatingStreamWrapper(
		"cline",
		{
			listProviderCredentialIds: async () => [delegatedCredentialId, "cline-1"],
			acquireCredential: async (
				_provider: string,
				requestOptions?: { excludedCredentialIds?: Set<string> },
			) => {
				const excludedCredentialIds = [...(requestOptions?.excludedCredentialIds ?? new Set<string>())].sort();
				acquiredCredentialSelections.push(excludedCredentialIds);
				assert.deepEqual(excludedCredentialIds, ["cline-1"]);
				return {
					provider: "cline",
					credentialId: delegatedCredentialId,
					credential: {
						type: "oauth",
						access: "fresh-token",
						refresh: "refresh-token",
						expires: Date.now() + 3_600_000,
						provider: "cline",
					},
					secret: "workos:fresh-token",
					index: 0,
				};
			},
			recordCredentialSuccess: async () => undefined,
			resolveFailoverTarget: async () => null,
			disableApiKeyCredential: async () => undefined,
			markTransientProviderError: async () => 0,
			markQuotaExceeded: async () => undefined,
		} as unknown as AccountManager,
		{
			streamSimple: (
				_model: Model<"openai-completions">,
				_context: Context,
				options?: SimpleStreamOptions,
			) => {
				const apiKey = typeof options?.apiKey === "string" ? options.apiKey : "";
				if (apiKey === "workos:fresh-token") {
					return createStreamingBaseProvider(model, {
						thinking: "Pinned delegated credential.",
						text: "Delegated credential pinned successfully.",
					}).streamSimple();
				}

				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({
						type: "error",
						reason: "error",
						error: createAssistantMessageForTest(model, [], {
							stopReason: "error",
							errorMessage:
								'401 "Unauthorized: Please make sure you\'re using the latest version of Cline and re-authenticate your Cline account."',
						}),
					});
					stream.end();
				});
				return stream;
			},
		} as never,
	);

	const events = await collectAssistantEvents(
		wrapper(model, createTestContext(), { apiKey: "unused" }),
	);
	const doneEvent = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
	);
	assert.ok(doneEvent);
	assert.equal(acquiredCredentialSelections.length, 1);
	const textBlock = doneEvent.message.content.find(
		(block): block is Extract<(typeof doneEvent.message.content)[number], { type: "text" }> =>
			block.type === "text",
	);
	assert.ok(textBlock);
	assert.equal(textBlock.text, "Delegated credential pinned successfully.");
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
	);

	const events = await collectAssistantEvents(
		wrapper(model, createTestContext(), {
			apiKey: "secret",
			signal: abortController.signal,
		}),
	);
	assert.equal(events.length, 1);
	assert.equal(events[0]?.type, "error");
	if (events[0]?.type !== "error") {
		assert.fail("Expected an aborted terminal error event.");
	}
	assert.equal(events[0].reason, "aborted");
	assert.equal(events[0].error.stopReason, "aborted");
	assert.match(events[0].error.errorMessage ?? "", /aborted/i);
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

test("account manager deduplicates Cline OAuth credentials by account identity", async (t) => {
	const now = Date.now();
	const { accountManager } = await createAccountManagerHarness(t, {
		providerId: "cline",
		authData: {
			cline: {
				type: "oauth",
				access: "older-access",
				refresh: "older-refresh",
				expires: now + 60_000,
				provider: "cline",
				accountId: "acct-same",
				userInfo: { email: "same@example.com" },
			},
			"cline-1": {
				type: "oauth",
				access: "newer-access",
				refresh: "newer-refresh",
				expires: now + 120_000,
				provider: "cline",
				accountId: "acct-same",
				userInfo: { email: "same@example.com" },
			},
		},
	});

	await accountManager.ensureInitialized();

	assert.deepEqual(await accountManager.listProviderCredentialIds("cline"), ["cline-1"]);
});

test("account manager keeps Codex OAuth credentials separate across account plan contexts", async (t) => {
	const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 3_600;
	const { accountManager } = await createAccountManagerHarness(t, {
		providerId: "openai-codex",
		authData: {
			"openai-codex": {
				type: "oauth",
				access: createCodexIdentityJwt({
					expiresAtSeconds,
					accountId: "acct-personal",
					accountUserId: "user-same",
					email: "same@example.com",
				}),
				refresh: "refresh-personal",
				expires: Date.now() + 60_000,
				provider: "openai-codex",
				accountId: "acct-personal",
			},
			"openai-codex-1": {
				type: "oauth",
				access: createCodexIdentityJwt({
					expiresAtSeconds,
					accountId: "acct-business-team",
					accountUserId: "user-same",
					email: "same@example.com",
				}),
				refresh: "refresh-business-team",
				expires: Date.now() + 120_000,
				provider: "openai-codex",
				accountId: "acct-business-team",
			},
		},
	});

	await accountManager.ensureInitialized();

	const credentialIds = await accountManager.listProviderCredentialIds("openai-codex");
	const providerStatus = await accountManager.getProviderStatus("openai-codex");
	const status = await accountManager.getStatus();
	const codexStatus = status.find((entry) => entry.provider === "openai-codex");

	assert.deepEqual(credentialIds, ["openai-codex", "openai-codex-1"]);
	assert.deepEqual(
		providerStatus.credentials.map((credential) => credential.credentialId),
		["openai-codex", "openai-codex-1"],
	);
	assert.deepEqual(
		codexStatus?.credentials.map((credential) => credential.credentialId),
		["openai-codex", "openai-codex-1"],
	);
});

test("account manager preserves Codex direct-login credential ids when identities match", async (t) => {
	const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 3_600;
	const baseExpires = Date.now() + 180_000;
	const backupExpires = Date.now() + 60_000;
	const baseCredential = {
		type: "oauth" as const,
		["access"]: createCodexIdentityJwt({
			expiresAtSeconds,
			accountId: "acct-direct-login",
			accountUserId: "user-same",
			email: "same@example.com",
		}),
		refresh: "base-refresh",
		expires: baseExpires,
		provider: "openai-codex",
		accountId: "acct-direct-login",
	};
	const backupCredential = {
		type: "oauth" as const,
		["access"]: createCodexIdentityJwt({
			expiresAtSeconds,
			accountId: "acct-direct-login",
			accountUserId: "user-same",
			email: "same@example.com",
		}),
		refresh: "backup-refresh",
		expires: backupExpires,
		provider: "openai-codex",
		accountId: "acct-direct-login",
	};
	const { accountManager, authPath } = await createAccountManagerHarness(t, {
		providerId: "openai-codex",
		authData: {
			"openai-codex": baseCredential,
			"openai-codex-17": backupCredential,
		},
	});

	await accountManager.ensureInitialized();

	const credentialIds = await accountManager.listProviderCredentialIds("openai-codex");
	const providerStatusCredentialIds = (await accountManager.getProviderStatus("openai-codex")).credentials.map(
		(credential) => credential.credentialId,
	);
	const allStatusCredentialIds = (await accountManager.getStatus())
		.find((entry) => entry.provider === "openai-codex")
		?.credentials.map((credential) => credential.credentialId);
	const authData = JSON.parse(await readFile(authPath, "utf-8")) as Record<
		string,
		{ expires?: number }
	>;

	assert.deepEqual(credentialIds, ["openai-codex", "openai-codex-17"]);
	assert.deepEqual(providerStatusCredentialIds, ["openai-codex", "openai-codex-17"]);
	assert.deepEqual(allStatusCredentialIds, ["openai-codex", "openai-codex-17"]);
	assert.deepEqual(Object.keys(authData).sort(), ["openai-codex", "openai-codex-17"]);
	assert.equal(authData["openai-codex"]?.expires, baseExpires);
	assert.equal(authData["openai-codex-17"]?.expires, backupExpires);
});

test("account manager updates an existing Cline OAuth credential instead of adding a duplicate login", async (t) => {
	resetOAuthProviders();
	t.after(() => {
		resetOAuthProviders();
	});

	registerOAuthProvider({
		id: "cline",
		name: "Cline",
		usesCallbackServer: false,
		login: async () => ({
			access: "new-access",
			refresh: "new-refresh",
			expires: Date.now() + 3_600_000,
			provider: "cline",
			accountId: "acct-same",
			userInfo: { email: "same@example.com" },
		}),
		refreshToken: async (credentials) => credentials,
		getApiKey: (credentials) => `workos:${credentials.access}`,
	});

	const { accountManager, authPath } = await createAccountManagerHarness(t, {
		providerId: "cline",
		authData: {
			cline: {
				type: "oauth",
				access: "old-access",
				refresh: "old-refresh",
				expires: Date.now() + 60_000,
				provider: "cline",
				accountId: "acct-same",
				userInfo: { email: "same@example.com" },
			},
		},
	});

	const result = await accountManager.loginProvider("cline", {
		onAuth: () => {},
		onPrompt: async () => "unused",
	});
	const authData = JSON.parse(await readFile(authPath, "utf-8")) as Record<string, StoredAuthCredential>;

	assert.equal(result.credentialId, "cline");
	assert.deepEqual(result.credentialIds, ["cline"]);
	assert.deepEqual(Object.keys(authData), ["cline"]);
	assert.equal(authData.cline?.type, "oauth");
	assert.equal(authData.cline?.type === "oauth" ? authData.cline.access : undefined, "new-access");
});

test("account manager keeps the recovered round-robin credential active after retry selection", async (t) => {
	const providerId = "cline";
	registerClineOAuthProvider();
	const primaryCredentialId = providerId;
	const secondaryCredentialId = `${providerId}-1`;
	const { accountManager, storagePath } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[primaryCredentialId]: { type: "api_key", key: "alpha" },
			[secondaryCredentialId]: { type: "api_key", key: "beta" },
		},
	});

	await accountManager.ensureInitialized();
	const first = await accountManager.acquireCredential(providerId);
	assert.equal(first.credentialId, primaryCredentialId);

	const second = await accountManager.acquireCredential(providerId, {
		excludedCredentialIds: new Set([first.credentialId]),
	});
	assert.equal(second.credentialId, secondaryCredentialId);

	const storageData = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<string, { credentialIds: string[]; activeIndex: number }>;
	};
	assert.equal(storageData.providers[providerId]?.activeIndex, 1);
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
	const usageService = new UsageService(undefined, undefined, undefined, undefined, { persistentCache: false });
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

	t.after(async () => {
		await accountManager.shutdown();
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

test("provider registry lists pi-mono API-key, models.json, and credential-known providers", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-api-key-providers-"));
	const authPath = join(tempRoot, "auth.json");
	const modelsPath = join(tempRoot, "models.json");

	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	await writeFile(
		authPath,
		JSON.stringify(
			{
				"credential-known-provider": { type: "api_key", key: "credential-key" },
			},
			null,
			2,
		),
		"utf-8",
	);
	await writeFile(
		modelsPath,
		JSON.stringify(
			{
				providers: {
					"custom-model-provider": {
						api: "openai",
						baseUrl: "https://example.test/v1",
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			},
			null,
			2,
		),
		"utf-8",
	);

	const registry = new ProviderRegistry(new AuthWriter(authPath), modelsPath, []);
	const providers = await registry.listAvailableApiKeyProviders();
	const providerIds = providers.map((provider) => provider.provider);

	assert.ok(providerIds.includes("openrouter"), "expected mirrored pi-mono API-key provider");
	assert.ok(providerIds.includes("custom-model-provider"), "expected models.json provider");
	assert.ok(providerIds.includes("credential-known-provider"), "expected auth.json provider");
	assert.equal(
		providers.find((provider) => provider.provider === "openrouter")?.name,
		"OpenRouter",
	);
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
		new UsageService(undefined, undefined, undefined, undefined, { persistentCache: false }),
		new ProviderRegistry(new AuthWriter(harness.authPath), harness.modelsPath, [providerId]),
		undefined,
		cloneExtensionConfig(),
	);
	t.after(async () => {
		await restarted.shutdown();
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
	const extractedHealthEntry = Object.values(healthHistory.providers?.[providerId] ?? {})[0];
	const score = stored.providers[providerId]?.healthState?.scores?.[providerId];
	assert.ok(score);
	assert.ok(score.score > 0.6);
	assert.equal(score.isStale, false);
	assert.equal(stored.providers[providerId]?.healthState?.history, undefined);
	assert.equal(extractedHealthEntry?.requests?.length, 1);
	assert.equal(extractedHealthEntry?.requests?.[0]?.success, true);
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
		const credentialRef = "migration-credential-ref";
		const state = createDefaultMultiAuthState([providerId]);
		const providerState = getProviderState(state, providerId);
		providerState.credentialIds = [credentialRef];
		providerState.healthState = {
			scores: {
				[credentialRef]: {
					credentialId: credentialRef,
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
				[credentialRef]: {
					credentialId: credentialRef,
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
								credentialId: credentialRef,
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
			hydrated.providers[providerId]?.healthState?.history?.[credentialRef]?.requests.length,
			1,
		);
		assert.equal(
			hydrated.providers[providerId]?.cascadeState?.[providerId]?.history?.[0]?.attemptCount,
			1,
		);

		await storage.withLock((current) => {
			const currentProviderState = getProviderState(current, providerId);
			currentProviderState.lastUsedAt[credentialRef] = 1_717_000_002_000;
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
		const extractedHealthHistoryContent = await readFile(historyPaths.healthPath, "utf-8");
		const extractedCascadeHistoryContent = await readFile(historyPaths.cascadePath, "utf-8");
		const extractedHealthHistory = JSON.parse(extractedHealthHistoryContent) as {
			providers?: Record<string, Record<string, { credentialId?: string; requests?: Array<unknown> }>>;
		};
		const extractedCascadeHistory = JSON.parse(extractedCascadeHistoryContent) as {
			providers?: Record<
				string,
				Record<string, Array<{ cascadePath: Array<{ credentialId?: string; errorMessage: string }> }>>
			>;
		};
		const extractedProviderHealth = extractedHealthHistory.providers?.[providerId] ?? {};
		const extractedHealthEntry = Object.values(extractedProviderHealth)[0];
		const extractedCascadeAttempt =
			extractedCascadeHistory.providers?.[providerId]?.[providerId]?.[0]?.cascadePath[0];
		const rehydrated = await storage.read();

		assert.equal(compactState.providers[providerId]?.healthState?.history, undefined);
		assert.equal(compactState.providers[providerId]?.cascadeState, undefined);
		assert.equal(Object.hasOwn(extractedProviderHealth, credentialRef), false);
		assert.notEqual(extractedHealthEntry?.credentialId, credentialRef);
		assert.equal(extractedHealthEntry?.requests?.length, 1);
		assert.notEqual(extractedCascadeAttempt?.credentialId, credentialRef);
		assert.equal(extractedCascadeAttempt?.errorMessage, "legacy embedded history");
		assert.equal(extractedHealthHistoryContent.includes(credentialRef), false);
		assert.equal(extractedCascadeHistoryContent.includes(credentialRef), false);
		assert.equal(
			rehydrated.providers[providerId]?.healthState?.history?.[credentialRef]?.requests.length,
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

test("account manager skips expired JWT-backed Cline API-key credentials during selection", async (t) => {
	const providerId = "cline";
	registerClineOAuthProvider();
	const expiredJwt = createJwtWithExp(Math.floor(Date.now() / 1000) - 60);
	const validJwt = createJwtWithExp(Math.floor(Date.now() / 1000) + 3_600);
	const { accountManager } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: {
				type: "api_key",
				key: `workos:${expiredJwt}`,
			},
			[`${providerId}-1`]: {
				type: "api_key",
				key: `workos:${validJwt}`,
			},
		},
	});

	const selected = await accountManager.acquireCredential(providerId);
	assert.equal(selected.credentialId, `${providerId}-1`);

	const status = await accountManager.getProviderStatus(providerId);
	assert.equal(status.credentials[0]?.credentialId, providerId);
	assert.equal(status.credentials[0]?.isExpired, true);
	assert.ok((status.credentials[0]?.expiresAt ?? 0) <= Date.now());
	assert.equal(status.credentials[1]?.credentialId, `${providerId}-1`);
	assert.equal(status.credentials[1]?.isExpired, false);
});

test("manual active expired JWT-backed Cline API-key credentials raise a clear re-authentication error", async (t) => {
	const providerId = "cline";
	registerClineOAuthProvider();
	const expiredJwt = createJwtWithExp(Math.floor(Date.now() / 1000) - 60);
	const validJwt = createJwtWithExp(Math.floor(Date.now() / 1000) + 3_600);
	const { accountManager } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: {
				type: "api_key",
				key: `workos:${expiredJwt}`,
			},
			[`${providerId}-1`]: {
				type: "api_key",
				key: `workos:${validJwt}`,
			},
		},
	});

	await accountManager.switchActiveCredential(providerId, 0);
	await assert.rejects(
		accountManager.acquireCredential(providerId),
		/expired WorkOS token|re-authenticate/i,
	);
});

test("acquireCredential prefixes Cline OAuth access tokens for request auth", async (t) => {
	const providerId = "cline";
	registerClineOAuthProvider();
	const { accountManager } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 3_600_000,
				accountId: "usr_123",
				provider: "cline",
				userInfo: {
					email: "person@example.com",
					displayName: "Person Example",
				},
			},
		},
	});

	const selected = await accountManager.acquireCredential(providerId);
	assert.equal(selected.secret, "workos:access-token");
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

test("shared auth error helpers normalize structured refresh failures safely", () => {
	assert.equal(getErrorMessage(new Error("boom")), "boom");
	assert.equal(getErrorMessage("string failure"), "string failure");
	assert.equal(
		getErrorMessage({ code: "boom" }, { preserveStructuredData: true }),
		'{"code":"boom"}',
	);
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	assert.equal(getErrorMessage(circular, { preserveStructuredData: true }), "[object Object]");
	assert.equal(isRecord({ ok: true }), true);
	assert.equal(isRecord(["nope"]), false);
	assert.equal(isRecord(null), false);
	assert.deepEqual(inferOAuthRefreshFailureMetadata("invalid_grant: refresh token expired"), {
		errorCode: "invalid_grant",
		reason: "token_rejected",
		permanent: true,
	});
	assert.equal(
		formatOAuthRefreshFailureSummary({
			providerLabel: "OpenAI Codex",
			status: 400,
			errorCode: "invalid_grant",
			reason: "token_rejected",
			permanent: true,
			source: "extension",
		}),
		"OpenAI Codex refresh rejected permanently (HTTP 400, code=invalid_grant)",
	);
});

test("async buffered log writer hardens debug log permissions after append", async (t) => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-multi-auth-debug-log-"));
	t.after(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	const logPath = join(tempDir, "debug.log");
	await writeFile(logPath, "existing\n", "utf-8");
	if (process.platform !== "win32") {
		await chmod(logPath, 0o644);
	}

	const writer = new AsyncBufferedLogWriter({
		enabled: true,
		logPath,
		ensureDirectory: () => undefined,
		flushIntervalMs: 60_000,
	});

	assert.equal(writer.writeLine("appended"), undefined);
	await writer.flush();

	assert.equal(await readFile(logPath, "utf-8"), "existing\nappended\n");
	if (process.platform !== "win32") {
		assert.equal((await stat(logPath)).mode & 0o777, 0o600);
	}
});

test("openai codex refresh failures omit raw response bodies from error details and messages", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				unexpected: "access_token=raw-secret-token",
				note: "refresh_token=raw-refresh-token",
			}),
			{
				status: 400,
				headers: { "Content-Type": "application/json" },
			},
		);

	await assert.rejects(
		() =>
			refreshOAuthCredential("openai-codex", {
				access: "stale-access-token",
				refresh: "refresh-token",
				expires: Date.now() - 60_000,
			}),
		(error: unknown) => {
			assert.ok(error instanceof OAuthRefreshFailureError);
			assert.equal(error.details.status, 400);
			assert.equal(error.details.reason, "http_error");
			assert.equal(error.details.errorCode, undefined);
			assert.doesNotMatch(error.message, /raw-secret-token|raw-refresh-token|access_token|refresh_token/i);
			return true;
		},
	);
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

test("account manager refreshCredential only updates the selected OAuth credential", async (t) => {
	resetOAuthProviders();
	t.after(() => {
		resetOAuthProviders();
	});

	const providerId = "refresh-scope-provider";
	const primaryCredentialId = providerId;
	const backupCredentialId = `${providerId}-1`;
	const refreshCalls: string[] = [];
	const primaryExpires = Date.now() + 90_000;
	const backupExpires = Date.now() + 120_000;

	registerOAuthProvider({
		id: providerId,
		name: "Refresh Scope Provider",
		usesCallbackServer: false,
		login: async () => {
			throw new Error("Login is not used in this test.");
		},
		refreshToken: async (credentials) => {
			refreshCalls.push(String(credentials.accountId ?? "unknown"));
			return {
				...credentials,
				["access"]: `refreshed-access-${credentials.accountId}`,
				["refresh"]: `refreshed-refresh-${credentials.accountId}`,
				expires: Date.now() + 3_600_000,
			};
		},
		getApiKey: () => "unused-api-key",
	});

	const { accountManager, authPath } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[primaryCredentialId]: {
				type: "oauth",
				["access"]: "test-access-primary",
				["refresh"]: "test-refresh-primary",
				expires: primaryExpires,
				provider: providerId,
				accountId: "acct-primary",
			},
			[backupCredentialId]: {
				type: "oauth",
				["access"]: "test-access-backup",
				["refresh"]: "test-refresh-backup",
				expires: backupExpires,
				provider: providerId,
				accountId: "acct-backup",
			},
		},
	});

	await accountManager.ensureInitialized();

	const refreshResult = await accountManager.refreshCredential(providerId, backupCredentialId);
	const authData = JSON.parse(await readFile(authPath, "utf-8")) as Record<string, StoredAuthCredential>;
	const primaryCredential = authData[primaryCredentialId];
	const refreshedCredential = authData[backupCredentialId];

	assert.deepEqual(refreshCalls, ["acct-backup"]);
	assert.equal(refreshResult.disposition, "refreshed");
	assert.equal(refreshResult.credential.accountId, "acct-backup");
	assert.equal(primaryCredential?.type, "oauth");
	assert.equal(
		primaryCredential?.type === "oauth" ? primaryCredential.access : undefined,
		"test-access-primary",
	);
	assert.equal(
		primaryCredential?.type === "oauth" ? primaryCredential.refresh : undefined,
		"test-refresh-primary",
	);
	assert.equal(primaryCredential?.type === "oauth" ? primaryCredential.expires : undefined, primaryExpires);
	assert.equal(refreshedCredential?.type, "oauth");
	assert.equal(
		refreshedCredential?.type === "oauth" ? refreshedCredential.access : undefined,
		"refreshed-access-acct-backup",
	);
	assert.equal(
		refreshedCredential?.type === "oauth" ? refreshedCredential.refresh : undefined,
		"refreshed-refresh-acct-backup",
	);
	assert.ok(
		(refreshedCredential?.type === "oauth" ? refreshedCredential.expires : 0) > backupExpires,
		"expected selected credential expiry to move forward after refresh",
	);
});

test("account manager disables permanently invalid Codex refresh credentials without console noise", async (t) => {
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
				error_description: "Refresh token raw-refresh-token-123 has expired or was revoked.",
				access_token: "raw-access-token-123",
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
	const disabledLog = debugEntries.find(
		(entry) => entry.event === "oauth_refresh_codex_disabled",
	);
	const providerStatus = await accountManager.getProviderStatus(providerId);
	const statusCredential = providerStatus.credentials.find(
		(credential) => credential.credentialId === providerId,
	);

	assert.equal(consoleErrorCalls, 0);
	assert.ok(refreshFailureLog);
	assert.equal(refreshFailureLog?.payload.permanent, true);
	assert.equal(refreshFailureLog?.payload.status, 400);
	assert.equal(refreshFailureLog?.payload.errorCode, "invalid_grant");
	assert.equal(refreshFailureLog?.payload.reason, "token_rejected");
	assert.equal("errorDescription" in (refreshFailureLog?.payload ?? {}), false);
	assert.equal("responseBody" in (refreshFailureLog?.payload ?? {}), false);
	assert.ok(disabledLog);
	assert.equal(disabledLog?.payload.errorCode, "invalid_grant");
	assert.equal(quotaExhaustedUntil, undefined);
	assert.equal(lastQuotaError, undefined);
	assert.ok(disabledEntry);
	assert.match(disabledEntry?.error ?? "", /invalid_grant/);
	assert.doesNotMatch(disabledEntry?.error ?? "", /raw-refresh-token-123|raw-access-token-123|revoked/i);
	assert.equal(statusCredential?.disabledError, disabledEntry?.error);
	assert.doesNotMatch(
		String(refreshFailureLog?.payload.message ?? ""),
		/raw-refresh-token-123|raw-access-token-123|revoked/i,
	);
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

test("account manager schedules cline oauth refresh and clears stale refresh disable state", async (t) => {
	const providerId = "cline";
	const expiresAt = Date.now() + 10 * 60_000;
	const jwt = createJwtWithExp(Math.floor(expiresAt / 1_000));
	const { accountManager, authPath, storagePath } = await createAccountManagerHarness(t, {
		providerId,
		authData: {
			[providerId]: {
				type: "oauth",
				access: jwt,
				refresh: "refresh-token",
				expires: expiresAt,
				provider: providerId,
			},
		},
	});
	const staleState = createDefaultMultiAuthState([providerId]);
	const clineState = getProviderState(staleState, providerId);
	clineState.credentialIds = [providerId];
	clineState.disabledCredentials[providerId] = {
		error: "Failed to refresh OAuth token for cline: cline refresh rejected permanently (HTTP 400, code=failed_to_refresh_token)",
		disabledAt: Date.now(),
	};
	clineState.oauthRefreshScheduled = {
		[providerId]: Date.now() + 60_000,
	};
	await writeFile(storagePath, JSON.stringify(staleState, null, 2), "utf-8");

	await accountManager.ensureInitialized();

	const stored = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<
			string,
			{
				disabledCredentials?: Record<string, { error: string; disabledAt: number }>;
				oauthRefreshScheduled?: Record<string, number>;
			}
		>;
	};
	assert.deepEqual(stored.providers[providerId]?.disabledCredentials ?? {}, {});
	const scheduledAt = stored.providers[providerId]?.oauthRefreshScheduled?.[providerId];
	assert.ok(typeof scheduledAt === "number");
	assert.ok(scheduledAt <= expiresAt - 5 * 60_000 + 1_000);
	assert.ok(scheduledAt >= Date.now());

	const authAfterInitialization = await readFile(authPath, "utf-8");
	assert.match(authAfterInitialization, /refresh-token/);
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
