import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	getApiProvider,
	type Model,
	registerApiProvider,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	AccountManager,
	createCredentialSelectionCache,
} from "./account-manager.js";
import {
	classifyCredentialError,
	isRetryableModelAvailabilityError,
	type CredentialErrorKind,
} from "./error-classifier.js";
import { multiAuthDebugLogger } from "./debug-logger.js";
import { ProviderRegistry } from "./provider-registry.js";
import { createStreamAttemptWatchdog } from "./stream-watchdog.js";
import {
	DEFAULT_STREAM_TIMEOUT_CONFIG,
	type StreamTimeoutConfig,
} from "./types-stream-timeout.js";
import type {
	ProviderRegistrationMetadata,
	SupportedProviderId,
} from "./types.js";

const MAX_ROTATION_RETRIES = 10;
const MAX_TRANSIENT_RETRIES_PER_CREDENTIAL = 2;
const PROVIDER_REGISTRATION_CHURN_WINDOW_MS = 100;

type ApiProviderRef = NonNullable<ReturnType<typeof getApiProvider>>;

type ProviderRegistrationMetricState = {
	discoveryCount: number;
	registrationCount: number;
	duplicateRegistrationCount: number;
	lastDiscoveredAt?: number;
	lastRegisteredAt?: number;
	lastRegistrationDeltaMs?: number;
};

export interface ProviderRegistrationMetricsSnapshot {
	discoveryCount: number;
	registrationCount: number;
	duplicateRegistrationCount: number;
	providers: Record<string, ProviderRegistrationMetricState>;
}

const providerRegistrationMetrics = {
	discoveryCount: 0,
	registrationCount: 0,
	duplicateRegistrationCount: 0,
	providers: new Map<string, ProviderRegistrationMetricState>(),
};

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function getAssistantErrorMessage(error: AssistantMessage): string {
	if (typeof error.errorMessage === "string" && error.errorMessage.trim().length > 0) {
		return error.errorMessage;
	}
	return getErrorMessage(error);
}

function getOrCreateProviderRegistrationMetricState(
	provider: SupportedProviderId,
): ProviderRegistrationMetricState {
	const existing = providerRegistrationMetrics.providers.get(provider);
	if (existing) {
		return existing;
	}

	const created: ProviderRegistrationMetricState = {
		discoveryCount: 0,
		registrationCount: 0,
		duplicateRegistrationCount: 0,
	};
	providerRegistrationMetrics.providers.set(provider, created);
	return created;
}

function recordProviderDiscovery(provider: SupportedProviderId): void {
	const metrics = getOrCreateProviderRegistrationMetricState(provider);
	metrics.discoveryCount += 1;
	metrics.lastDiscoveredAt = Date.now();
	providerRegistrationMetrics.discoveryCount += 1;
}

function recordProviderRegistration(provider: SupportedProviderId): ProviderRegistrationMetricState {
	const metrics = getOrCreateProviderRegistrationMetricState(provider);
	const now = Date.now();
	const lastRegisteredAt = metrics.lastRegisteredAt;
	const deltaMs = typeof lastRegisteredAt === "number" ? now - lastRegisteredAt : undefined;
	metrics.registrationCount += 1;
	metrics.lastRegisteredAt = now;
	metrics.lastRegistrationDeltaMs = deltaMs;
	providerRegistrationMetrics.registrationCount += 1;
	if (
		typeof deltaMs === "number" &&
		deltaMs >= 0 &&
		deltaMs <= PROVIDER_REGISTRATION_CHURN_WINDOW_MS
	) {
		metrics.duplicateRegistrationCount += 1;
		providerRegistrationMetrics.duplicateRegistrationCount += 1;
	}
	return metrics;
}

export function getProviderRegistrationMetrics(): ProviderRegistrationMetricsSnapshot {
	return {
		discoveryCount: providerRegistrationMetrics.discoveryCount,
		registrationCount: providerRegistrationMetrics.registrationCount,
		duplicateRegistrationCount: providerRegistrationMetrics.duplicateRegistrationCount,
		providers: Object.fromEntries(
			[...providerRegistrationMetrics.providers.entries()].map(([provider, metrics]) => [
				provider,
				{ ...metrics },
			]),
		),
	};
}

function isSubstantiveEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "text_end":
		case "thinking_delta":
		case "thinking_end":
		case "toolcall_delta":
		case "toolcall_end":
		case "done":
			return true;
		default:
			return false;
	}
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const LETTER_OR_NUMBER_PATTERN = /[\p{L}\p{N}]/u;
const WHITESPACE_PATTERN = /\s/u;
const STRUCTURAL_SYMBOL_PATTERN = /[\[\]{}<>|^_=+*\\/~】》■•]/u;
const LONG_STRUCTURAL_RUN_PATTERN = /(?:[\[\]{}<>|^_=+*\\/~-]{12,}|[】》■•]{4,})/u;
const MALFORMED_THINKING_DECISION_MIN_CHARS = 96;
const MALFORMED_THINKING_MIN_CHARS = 128;
const MALFORMED_THINKING_MAX_LETTER_RATIO = 0.25;
const MALFORMED_THINKING_MIN_PUNCTUATION_RATIO = 0.45;
const MALFORMED_THINKING_MIN_STRUCTURAL_RATIO = 0.2;

type BufferedThinkingStartEvent = Extract<AssistantMessageEvent, { type: "thinking_start" }>;
type BufferedThinkingDeltaEvent = Extract<AssistantMessageEvent, { type: "thinking_delta" }>;
type BufferedThinkingGuardState = {
	pendingStartEvent: BufferedThinkingStartEvent | null;
	pendingDeltaEvents: BufferedThinkingDeltaEvent[];
	pendingText: string;
	forwardedCurrentThinking: boolean;
	isDroppingCurrentThinking: boolean;
};

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function isOllamaProvider(provider: SupportedProviderId): boolean {
	return provider.trim().toLowerCase() === "ollama";
}

function isMalformedThinkingText(text: string): boolean {
	const normalized = stripAnsi(text).trim();
	if (normalized.length < MALFORMED_THINKING_MIN_CHARS) {
		return false;
	}

	let letterOrNumberCount = 0;
	let punctuationCount = 0;
	let structuralSymbolCount = 0;

	for (const char of normalized) {
		if (LETTER_OR_NUMBER_PATTERN.test(char)) {
			letterOrNumberCount += 1;
			continue;
		}
		if (WHITESPACE_PATTERN.test(char)) {
			continue;
		}

		punctuationCount += 1;
		if (STRUCTURAL_SYMBOL_PATTERN.test(char)) {
			structuralSymbolCount += 1;
		}
	}

	if (letterOrNumberCount === 0) {
		return true;
	}

	const totalLength = normalized.length;
	const letterRatio = letterOrNumberCount / totalLength;
	const punctuationRatio = punctuationCount / totalLength;
	const structuralRatio = structuralSymbolCount / totalLength;

	return (
		LONG_STRUCTURAL_RUN_PATTERN.test(normalized) ||
		(letterRatio < MALFORMED_THINKING_MAX_LETTER_RATIO &&
			punctuationRatio > MALFORMED_THINKING_MIN_PUNCTUATION_RATIO &&
			structuralRatio > MALFORMED_THINKING_MIN_STRUCTURAL_RATIO)
	);
}

function sanitizeAssistantThinkingBlocks(
	message: AssistantMessage,
	provider: SupportedProviderId,
): AssistantMessage {
	if (!isOllamaProvider(provider) || !Array.isArray(message.content)) {
		return message;
	}

	let changed = false;
	const nextContent = message.content.filter((block) => {
		if (block.type !== "thinking") {
			return true;
		}
		if (!isMalformedThinkingText(block.thinking)) {
			return true;
		}

		changed = true;
		return false;
	});

	return changed ? { ...message, content: nextContent } : message;
}

function sanitizeAssistantPayloadsInEvent(
	event: AssistantMessageEvent,
	provider: SupportedProviderId,
): AssistantMessageEvent {
	switch (event.type) {
		case "start":
		case "text_start":
		case "text_delta":
		case "text_end":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
		case "toolcall_start":
		case "toolcall_delta":
		case "toolcall_end":
			return {
				...event,
				partial: sanitizeAssistantThinkingBlocks(event.partial, provider),
			};
		case "done":
			return {
				...event,
				message: sanitizeAssistantThinkingBlocks(event.message, provider),
			};
		case "error":
			return {
				...event,
				error: sanitizeAssistantThinkingBlocks(event.error, provider),
			};
		default:
			return event;
	}
}

function resetBufferedThinkingState(state: BufferedThinkingGuardState): void {
	state.pendingStartEvent = null;
	state.pendingDeltaEvents = [];
	state.pendingText = "";
	state.forwardedCurrentThinking = false;
	state.isDroppingCurrentThinking = false;
}

function createBufferedThinkingState(): BufferedThinkingGuardState {
	return {
		pendingStartEvent: null,
		pendingDeltaEvents: [],
		pendingText: "",
		forwardedCurrentThinking: false,
		isDroppingCurrentThinking: false,
	};
}

function flushBufferedThinkingEvents(
	state: BufferedThinkingGuardState,
	provider: SupportedProviderId,
): AssistantMessageEvent[] {
	if (!state.pendingStartEvent) {
		return [];
	}

	state.forwardedCurrentThinking = true;
	return [state.pendingStartEvent, ...state.pendingDeltaEvents].map((event) =>
		sanitizeAssistantPayloadsInEvent(event, provider),
	);
}

function sanitizeOllamaThinkingEvent(
	event: AssistantMessageEvent,
	provider: SupportedProviderId,
	state: BufferedThinkingGuardState,
): AssistantMessageEvent[] {
	if (!isOllamaProvider(provider)) {
		return [sanitizeAssistantPayloadsInEvent(event, provider)];
	}

	switch (event.type) {
		case "thinking_start": {
			resetBufferedThinkingState(state);
			state.pendingStartEvent = event;
			return [];
		}
		case "thinking_delta": {
			if (!state.pendingStartEvent) {
				return [sanitizeAssistantPayloadsInEvent(event, provider)];
			}
			if (state.isDroppingCurrentThinking) {
				return [];
			}
			if (state.forwardedCurrentThinking) {
				return [sanitizeAssistantPayloadsInEvent(event, provider)];
			}

			state.pendingDeltaEvents.push(event);
			state.pendingText += event.delta;
			if (state.pendingText.trim().length < MALFORMED_THINKING_DECISION_MIN_CHARS) {
				return [];
			}
			if (isMalformedThinkingText(state.pendingText)) {
				state.isDroppingCurrentThinking = true;
				return [];
			}

			return flushBufferedThinkingEvents(state, provider);
		}
		case "thinking_end": {
			if (!state.pendingStartEvent) {
				return [sanitizeAssistantPayloadsInEvent(event, provider)];
			}
			if (state.isDroppingCurrentThinking) {
				resetBufferedThinkingState(state);
				return [];
			}
			if (state.forwardedCurrentThinking) {
				resetBufferedThinkingState(state);
				return [sanitizeAssistantPayloadsInEvent(event, provider)];
			}

			const completeThinking = state.pendingText || event.content;
			if (isMalformedThinkingText(completeThinking)) {
				resetBufferedThinkingState(state);
				return [];
			}

			const forwardedEvents = [
				...flushBufferedThinkingEvents(state, provider),
				sanitizeAssistantPayloadsInEvent(event, provider),
			];
			resetBufferedThinkingState(state);
			return forwardedEvents;
		}
		case "done":
		case "error":
			resetBufferedThinkingState(state);
			return [sanitizeAssistantPayloadsInEvent(event, provider)];
		default:
			return [sanitizeAssistantPayloadsInEvent(event, provider)];
	}
}

function createErrorAssistantMessage(model: Model<Api>, message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

function resolveCredentialProviderId(
	model: Model<Api>,
	fallbackProvider: SupportedProviderId,
): SupportedProviderId {
	const providerFromModel =
		typeof model.provider === "string" ? model.provider.trim() : "";
	return providerFromModel.length > 0 ? providerFromModel : fallbackProvider;
}

/**
 * Builds an API wrapper that injects rotated credentials and retries on quota/rate-limit errors.
 * Credential namespace is resolved from model.provider at request time.
 */
export function createRotatingStreamWrapper(
	fallbackProvider: SupportedProviderId,
	accountManager: AccountManager,
	baseProvider: ApiProviderRef,
	baseProvidersByApi: ReadonlyMap<Api, ApiProviderRef> = new Map(),
	streamTimeoutConfig: StreamTimeoutConfig = DEFAULT_STREAM_TIMEOUT_CONFIG,
): (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
	return (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		let activeProviderId = resolveCredentialProviderId(model, fallbackProvider);
		let activeModel = model;
		let activeBaseProvider = baseProvider;

		multiAuthDebugLogger.log("stream_invoked", {
			provider: model.provider,
			credentialProvider: activeProviderId,
			model: model.id,
		});

		(async () => {
			let excludedCredentialIds = new Set<string>();
			let lastRetryableMessage: string | null = null;
			let lastFailoverTrigger: CredentialErrorKind | null = null;
			const selectionCache = createCredentialSelectionCache();
			const bufferedThinkingState = createBufferedThinkingState();

			const switchToFailoverProvider = async (): Promise<boolean> => {
				if (!lastFailoverTrigger) {
					return false;
				}

				const target = await accountManager.resolveFailoverTarget(
					activeProviderId,
					lastFailoverTrigger,
					activeModel.id,
				);
				if (!target) {
					return false;
				}

				const failoverBaseProvider = baseProvidersByApi.get(target.api);
				if (!failoverBaseProvider) {
					throw new Error(
						`No base provider is registered for failover API '${target.api}' (${target.providerId}/${target.modelId}).`,
					);
				}

				multiAuthDebugLogger.log("chain_failover_activated", {
					fromProvider: activeProviderId,
					toProvider: target.providerId,
					modelId: target.modelId,
					api: target.api,
					chainId: target.chainId,
					position: target.position,
				});
				activeProviderId = target.providerId;
				activeModel = {
					...activeModel,
					provider: target.providerId,
					id: target.modelId,
					api: target.api,
				};
				activeBaseProvider = failoverBaseProvider;
				excludedCredentialIds = new Set<string>();
				lastRetryableMessage = null;
				lastFailoverTrigger = null;
				return true;
			};

			for (let attempt = 0; attempt <= MAX_ROTATION_RETRIES; attempt += 1) {
				let selected;
				try {
					selected = await accountManager.acquireCredential(activeProviderId, {
						excludedCredentialIds,
						modelId: activeModel.id,
						selectionCache,
					});
				} catch (error: unknown) {
					if (excludedCredentialIds.size > 0 && (await switchToFailoverProvider())) {
						continue;
					}
					if (excludedCredentialIds.size > 0) {
						const lastDetail = lastRetryableMessage
							? ` Last retryable error: ${lastRetryableMessage}`
							: ` Credential acquisition error: ${getErrorMessage(error)}`;
						throw new Error(
							`All ${excludedCredentialIds.size} rotated credential(s) for ${activeProviderId} failed.${lastDetail}`,
						);
					}
					throw error;
				}

				const resolveRetryDecision = async (
					message: string,
					hasForwardedSubstantiveEvent: boolean,
					transientAttempt: number,
				): Promise<"fail" | "retry_same_credential" | "rotate_credential"> => {
					const classification = classifyCredentialError(message, {
						providerId: activeProviderId,
						modelId: activeModel.id,
					});
					multiAuthDebugLogger.log("error_classified", {
						provider: activeProviderId,
						credentialId: selected.credentialId,
						kind: classification.kind,
						shouldDisable: classification.shouldDisableCredential,
						shouldRotate: classification.shouldRotateCredential,
						shouldCooldown: classification.shouldApplyCooldown,
						errorMessage: message.slice(0, 200),
					});

					if (classification.shouldDisableCredential) {
						try {
							await accountManager.disableApiKeyCredential(
								activeProviderId,
								selected.credentialId,
								message,
							);
							multiAuthDebugLogger.log("credential_disabled", {
								provider: activeProviderId,
								credentialId: selected.credentialId,
								kind: classification.kind,
								reason: message.slice(0, 200),
							});
						} catch (error: unknown) {
							multiAuthDebugLogger.log("credential_disable_failed", {
								provider: activeProviderId,
								credentialId: selected.credentialId,
								error: getErrorMessage(error),
							});
						}
					}

					if (hasForwardedSubstantiveEvent) {
						return "fail";
					}

					if (
						classification.shouldRetrySameCredential &&
						transientAttempt < MAX_TRANSIENT_RETRIES_PER_CREDENTIAL
					) {
						lastRetryableMessage = message;
						return "retry_same_credential";
					}

					if (
						(classification.kind === "provider_transient" ||
							classification.kind === "request_timeout") &&
						!hasForwardedSubstantiveEvent &&
						attempt < MAX_ROTATION_RETRIES
					) {
						const cooldownMs = await accountManager.markTransientProviderError(
							activeProviderId,
							selected.credentialId,
							message,
						);
						multiAuthDebugLogger.log("credential_transient_cooldown_recorded", {
							provider: activeProviderId,
							credentialId: selected.credentialId,
							cooldownMs,
							reason: message.slice(0, 200),
						});
						excludedCredentialIds.add(selected.credentialId);
						lastRetryableMessage = message;
						return "rotate_credential";
					}

					if (
						classification.shouldRotateCredential &&
						attempt < MAX_ROTATION_RETRIES
					) {
						if (classification.shouldApplyCooldown) {
							await accountManager.markQuotaExceeded(
								activeProviderId,
								selected.credentialId,
								{
									errorMessage: message,
									isWeekly: classification.kind === "quota_weekly",
									quotaClassification: classification.quotaClassification,
									recommendedCooldownMs: classification.recommendedCooldownMs,
								},
							);
						} else if (
							isRetryableModelAvailabilityError(message, {
								providerId: activeProviderId,
								modelId: activeModel.id,
							})
						) {
							const cooldownMs = await accountManager.markTransientProviderError(
								activeProviderId,
								selected.credentialId,
								message,
							);
							multiAuthDebugLogger.log("credential_transient_cooldown_recorded", {
								provider: activeProviderId,
								credentialId: selected.credentialId,
								cooldownMs,
								reason: message.slice(0, 200),
							});
						}
						lastFailoverTrigger = classification.kind;
						excludedCredentialIds.add(selected.credentialId);
						lastRetryableMessage = message;
						return "rotate_credential";
					}

					return "fail";
				};

				for (
					let transientAttempt = 0;
					transientAttempt <= MAX_TRANSIENT_RETRIES_PER_CREDENTIAL;
					transientAttempt += 1
				) {
					resetBufferedThinkingState(bufferedThinkingState);
					const requestStartedAt = Date.now();
					const watchdog = createStreamAttemptWatchdog({
						providerId: activeProviderId,
						credentialId: selected.credentialId,
						modelId: activeModel.id,
						timeoutConfig: streamTimeoutConfig,
						parentSignal: options?.signal,
					});
					let innerStream: AssistantMessageEventStream;
					try {
						innerStream = activeBaseProvider.streamSimple(activeModel, context, {
							...options,
							apiKey: selected.secret,
							signal: watchdog.signal,
						});
					} catch (error: unknown) {
						watchdog.dispose();
						if (watchdog.isCallerAbort(error)) {
							stream.end();
							return;
						}
						const retryError = watchdog.getTimeoutError() ?? error;
						const message = getErrorMessage(retryError);
						const decision = await resolveRetryDecision(
							message,
							false,
							transientAttempt,
						);
						if (decision === "retry_same_credential") {
							continue;
						}
						if (decision === "rotate_credential") {
							break;
						}
						throw retryError;
					}

					let forwardedAnyEvent = false;
					let hasForwardedSubstantiveEvent = false;
					let sawDoneEvent = false;
					let shouldRetrySameCredential = false;
					let shouldRotateCredential = false;

					try {
						for await (const rawEvent of innerStream) {
							watchdog.touch();
							const forwardedEvents = sanitizeOllamaThinkingEvent(
								rawEvent,
								activeProviderId,
								bufferedThinkingState,
							);
							for (const event of forwardedEvents) {
								if (event.type === "error") {
									if (
										watchdog.isCallerAbortMessage(getAssistantErrorMessage(event.error))
									) {
										stream.end();
										return;
									}
									const message =
										watchdog.getTimeoutError()?.message ??
										getAssistantErrorMessage(event.error);
									const decision = await resolveRetryDecision(
										message,
										hasForwardedSubstantiveEvent,
										transientAttempt,
									);
									if (decision === "retry_same_credential") {
										shouldRetrySameCredential = true;
										break;
									}
									if (decision === "rotate_credential") {
										shouldRotateCredential = true;
										break;
									}

									stream.push(event);
									stream.end();
									return;
								}

								forwardedAnyEvent = true;
								hasForwardedSubstantiveEvent ||= isSubstantiveEvent(event);
								stream.push(event);
								if (event.type === "done") {
									sawDoneEvent = true;
									await accountManager.recordCredentialSuccess(
										activeProviderId,
										selected.credentialId,
										Date.now() - requestStartedAt,
									);
									stream.end();
									return;
								}
							}

							if (shouldRetrySameCredential || shouldRotateCredential) {
								break;
							}
						}
					} catch (error: unknown) {
						if (watchdog.isCallerAbort(error)) {
							stream.end();
							return;
						}
						const retryError = watchdog.getTimeoutError() ?? error;
						const message = getErrorMessage(retryError);
						const decision = await resolveRetryDecision(
							message,
							hasForwardedSubstantiveEvent,
							transientAttempt,
						);
						if (decision === "retry_same_credential") {
							shouldRetrySameCredential = true;
						} else if (decision === "rotate_credential") {
							shouldRotateCredential = true;
						} else {
							throw retryError;
						}
					} finally {
						watchdog.dispose();
					}

					if (shouldRetrySameCredential) {
						continue;
					}

					if (shouldRotateCredential) {
						break;
					}

					if (!sawDoneEvent) {
						if (options?.signal?.aborted && !watchdog.getTimeoutError()) {
							stream.end();
							return;
						}
						const message =
							watchdog.getTimeoutError()?.message ??
							(!forwardedAnyEvent
								? `Provider stream ended before completion event for ${activeProviderId} (credential ${selected.credentialId}) without emitting any events.`
								: `Provider stream ended before completion event for ${activeProviderId} (credential ${selected.credentialId}).`);
						const decision = await resolveRetryDecision(
							message,
							hasForwardedSubstantiveEvent,
							transientAttempt,
						);
						if (decision === "retry_same_credential") {
							continue;
						}
						if (decision === "rotate_credential") {
							break;
						}
						throw new Error(message);
					}

					stream.end();
					return;
				}
			}

			const triedCount = excludedCredentialIds.size;
			const lastDetail = lastRetryableMessage
				? ` Last error: ${lastRetryableMessage}`
				: "";
			throw new Error(
				`Rotation exhausted for ${activeProviderId}: ${triedCount} credential(s) tried across ${MAX_ROTATION_RETRIES + 1} attempts, all appear quota-limited or rate-limited.${lastDetail}`,
			);
		})().catch((error: unknown) => {
			const assistantError: AssistantMessageEvent = {
				type: "error",
				reason: "error",
				error: createErrorAssistantMessage(
					activeModel,
					`multi-auth rotation failed for ${activeProviderId}: ${getErrorMessage(error)}`,
				),
			};
			stream.push(assistantError);
			stream.end();
		});

		return stream;
	};
}

/**
 * Resolves provider metadata required for registerProvider().
 */
export async function resolveProviderRegistrationMetadata(
	provider: SupportedProviderId,
	registry: ProviderRegistry = new ProviderRegistry(),
): Promise<ProviderRegistrationMetadata | null> {
	return registry.resolveProviderRegistrationMetadata(provider);
}

/**
 * Registers stream wrappers for all discovered providers with model metadata.
 */
export async function registerMultiAuthProviders(
	pi: ExtensionAPI,
	accountManager: AccountManager,
	options?: {
		excludeProviders?: string[];
		includeProviders?: string[];
		streamTimeouts?: StreamTimeoutConfig;
	},
): Promise<void> {
	const excludeSet = new Set(options?.excludeProviders ?? []);
	const includeSet =
		options?.includeProviders && options.includeProviders.length > 0
			? new Set(options.includeProviders)
			: null;
	const registry = accountManager.getProviderRegistry();
	const providers = await registry.discoverProviderIds();
	const metadataToRegister = (
		await Promise.all(
			providers.map(async (provider) => {
				if (excludeSet.has(provider)) {
					return null;
				}
				if (includeSet && !includeSet.has(provider)) {
					return null;
				}

				const metadata = await resolveProviderRegistrationMetadata(provider, registry);
				if (!metadata) {
					const isCredentialOnlyOAuthProvider = await registry.isCredentialOnlyOAuthProvider(provider);
					if (!isCredentialOnlyOAuthProvider) {
						multiAuthDebugLogger.log("provider_registration_skipped", {
							provider,
							reason: "no_model_metadata",
						});
					}
					return null;
				}

				if (metadata.models.length === 0) {
					multiAuthDebugLogger.log("provider_registration_skipped", {
						provider,
						reason: "no_models",
					});
					return null;
				}

				return metadata;
			}),
		)
	).filter((metadata): metadata is ProviderRegistrationMetadata => metadata !== null);

	for (const metadata of metadataToRegister) {
		recordProviderDiscovery(metadata.provider);
	}

	multiAuthDebugLogger.log("providers_discovered", {
		count: metadataToRegister.length,
		providers: metadataToRegister.map((metadata) => metadata.provider),
		metrics: getProviderRegistrationMetrics(),
	});

	const allApis = new Set<Api>();
	const fallbackProvidersByApi = new Map<Api, SupportedProviderId>();
	for (const metadata of metadataToRegister) {
		for (const model of metadata.models) {
			if (!model.api) {
				continue;
			}
			allApis.add(model.api);
			if (!fallbackProvidersByApi.has(model.api)) {
				fallbackProvidersByApi.set(model.api, metadata.provider);
			}
		}
		allApis.add(metadata.api);
		if (!fallbackProvidersByApi.has(metadata.api)) {
			fallbackProvidersByApi.set(metadata.api, metadata.provider);
		}
	}

	const wrappersByApi = new Map<Api, ReturnType<typeof createRotatingStreamWrapper>>();
	const baseProvidersByApi = new Map<Api, ApiProviderRef>();

	for (const api of allApis) {
		const baseProvider = getApiProvider(api);
		if (!baseProvider) {
			multiAuthDebugLogger.log("api_wrapper_unavailable", {
				api,
				reason: "no_base_api_provider",
			});
			continue;
		}

		baseProvidersByApi.set(api, baseProvider);
		const fallbackProvider = fallbackProvidersByApi.get(api) ?? (api as SupportedProviderId);
		const streamSimple = createRotatingStreamWrapper(
			fallbackProvider,
			accountManager,
			baseProvider,
			baseProvidersByApi,
			options?.streamTimeouts,
		);
		wrappersByApi.set(api, streamSimple);
		multiAuthDebugLogger.log("stream_wrapper_created", {
			api,
			fallbackProvider,
		});
	}

	for (const metadata of metadataToRegister) {
		const primaryApi = metadata.api;
		const primaryWrapper = wrappersByApi.get(primaryApi);
		if (!primaryWrapper) {
			multiAuthDebugLogger.log("provider_registration_skipped", {
				provider: metadata.provider,
				api: primaryApi,
				reason: "no_wrapper_for_api",
			});
			continue;
		}

		const providerApis = new Set<Api>();
		for (const model of metadata.models) {
			if (model.api) {
				providerApis.add(model.api);
			}
		}
		if (providerApis.size === 0) {
			providerApis.add(primaryApi);
		}

		for (const api of providerApis) {
			const wrapper = wrappersByApi.get(api);
			if (!wrapper) {
				multiAuthDebugLogger.log("provider_api_registration_skipped", {
					provider: metadata.provider,
					api,
					reason: "no_wrapper_for_api",
				});
				continue;
			}

			multiAuthDebugLogger.log("api_provider_registering", {
				provider: metadata.provider,
				api,
				sourceId: `provider:${metadata.provider}:${api}`,
			});

			registerApiProvider(
				{
					api,
					stream: (model, context, options) => wrapper(model, context, options as SimpleStreamOptions),
					streamSimple: wrapper,
				},
				`provider:${metadata.provider}:${api}`,
			);
		}

		const registrationMetrics = recordProviderRegistration(metadata.provider);
		multiAuthDebugLogger.log("provider_registered", {
			provider: metadata.provider,
			primaryApi,
			providerApis: [...providerApis],
			modelCount: metadata.models.filter((model) => (model.api ? providerApis.has(model.api) : true)).length,
			registrationCount: registrationMetrics.registrationCount,
			duplicateRegistrationCount: registrationMetrics.duplicateRegistrationCount,
			lastRegistrationDeltaMs: registrationMetrics.lastRegistrationDeltaMs,
		});

		pi.registerProvider(metadata.provider, {
			baseUrl: metadata.baseUrl,
			apiKey: "managed-by-multi-auth",
			api: primaryApi,
			models: metadata.models,
			streamSimple: primaryWrapper,
		});
	}
}
