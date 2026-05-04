import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { AccountManager } from "./account-manager.js";
import {
	registerGlobalKeyDistributor,
	unregisterGlobalKeyDistributor,
} from "./balancer/index.js";
import { registerMultiAuthCommands } from "./commands.js";
import { getErrorMessage } from "./auth-error-utils.js";
import { loadMultiAuthConfig } from "./config.js";
import { multiAuthDebugLogger } from "./debug-logger.js";
import { registerMultiAuthProviders } from "./provider.js";
import { registerClineOAuthProvider } from "./oauth-cline.js";
import { registerKiloOAuthProvider } from "./oauth-kilo.js";
import {
	isDelegatedSubagentRuntime,
	resolveRequestedProviderFromArgv,
} from "./runtime-context.js";

const STARTUP_WARMUP_DELAY_MS = 0;
const STARTUP_REFINEMENT_DELAY_MS = 1_500;

/**
 * Session start event payload.
 * The reason indicates the cause of the session start.
 */
interface SessionStartEvent {
	reason?: "new" | "resume" | "fork" | "reload";
	previousSessionFile?: string;
}

/**
 * pi-multi-auth extension entry point for multi-account OAuth credential management and rotation.
 */
export default async function multiAuthExtension(pi: ExtensionAPI): Promise<void> {
	const configLoadResult = loadMultiAuthConfig();
	registerClineOAuthProvider();
	registerKiloOAuthProvider();
	const isSubagentRuntime = isDelegatedSubagentRuntime();
	const requestedSubagentProvider = isSubagentRuntime
		? resolveRequestedProviderFromArgv()
		: undefined;
	const startupWarnings = new Set<string>();
	const recordStartupWarning = (
		message: string,
		context: string,
		error?: unknown,
		onError?: (message: string) => void,
	): void => {
		const normalizedMessage = message.trim();
		if (!normalizedMessage) {
			return;
		}
		startupWarnings.add(normalizedMessage);
		multiAuthDebugLogger.log("startup_warning", {
			context,
			message: normalizedMessage,
			error: error ? getErrorMessage(error) : undefined,
		});
		onError?.(normalizedMessage);
	};
	if (configLoadResult.warning) {
		recordStartupWarning(configLoadResult.warning, "config_load");
	}

	const accountManager = new AccountManager(
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		configLoadResult.config,
		{
			startOAuthRefreshScheduler: !isSubagentRuntime,
		},
	);
	const keyDistributor = accountManager.getKeyDistributor();
	registerGlobalKeyDistributor(keyDistributor);

	let warmupInFlight: Promise<void> | null = null;
	let warmupTimer: ReturnType<typeof setTimeout> | null = null;
	let warmupCompleted = false;
	let refinementInFlight: Promise<void> | null = null;
	let refinementTimer: ReturnType<typeof setTimeout> | null = null;
	let startupWorkGeneration = 0;
	let shutdownPromise: Promise<void> | null = null;

	const beginStartupWorkGeneration = (): number => {
		startupWorkGeneration += 1;
		return startupWorkGeneration;
	};

	const isStartupWorkCurrent = (generation: number): boolean => {
		return generation === startupWorkGeneration;
	};

	const clearStartupTimers = (): void => {
		if (warmupTimer !== null) {
			clearTimeout(warmupTimer);
			warmupTimer = null;
		}
		if (refinementTimer !== null) {
			clearTimeout(refinementTimer);
			refinementTimer = null;
		}
	};

	const scheduleRefinement = (
		generation: number,
		onError?: (message: string) => void,
	): void => {
		if (!isStartupWorkCurrent(generation) || refinementInFlight || refinementTimer) {
			return;
		}

		refinementTimer = setTimeout(() => {
			refinementTimer = null;
			if (!isStartupWorkCurrent(generation)) {
				return;
			}
			if (warmupInFlight) {
				scheduleRefinement(generation, onError);
				return;
			}

			let nextRefinement: Promise<void>;
			nextRefinement = accountManager
				.autoActivatePreferredCredentials()
				.catch((error: unknown) => {
					if (!isStartupWorkCurrent(generation)) {
						return;
					}
					recordStartupWarning(
						getErrorMessage(error),
						"startup_refinement",
						error,
						onError,
					);
				})
				.finally(() => {
					if (refinementInFlight === nextRefinement) {
						refinementInFlight = null;
					}
				});
			refinementInFlight = nextRefinement;
		}, STARTUP_REFINEMENT_DELAY_MS);
	};

	const startWarmup = (
		generation: number,
		onError?: (message: string) => void,
	): void => {
		if (!isStartupWorkCurrent(generation) || warmupInFlight) {
			return;
		}

		let nextWarmup: Promise<void>;
		nextWarmup = (async () => {
			await accountManager.ensureInitialized();
			await accountManager.autoActivatePreferredCredentials({ avoidUsageApi: true });
		})()
			.then(() => {
				if (!isStartupWorkCurrent(generation)) {
					return;
				}
				warmupCompleted = true;
				scheduleRefinement(generation, onError);
			})
			.catch((error: unknown) => {
				if (!isStartupWorkCurrent(generation)) {
					return;
				}
				recordStartupWarning(
					getErrorMessage(error),
					"startup_warmup",
					error,
					onError,
				);
			})
			.finally(() => {
				if (warmupInFlight === nextWarmup) {
					warmupInFlight = null;
				}
			});
		warmupInFlight = nextWarmup;
	};

	const scheduleWarmup = (
		generation: number,
		onError?: (message: string) => void,
	): void => {
		if (!isStartupWorkCurrent(generation) || warmupInFlight || warmupTimer) {
			return;
		}

		warmupTimer = setTimeout(() => {
			warmupTimer = null;
			if (!isStartupWorkCurrent(generation)) {
				return;
			}
			startWarmup(generation, onError);
		}, STARTUP_WARMUP_DELAY_MS);
	};

	const scheduleStartupWork = (
		generation: number,
		onError?: (message: string) => void,
	): void => {
		if (!isStartupWorkCurrent(generation)) {
			return;
		}
		if (!warmupCompleted) {
			scheduleWarmup(generation, onError);
			return;
		}
		scheduleRefinement(generation, onError);
	};

	const shutdownExtension = async (onWarning?: (message: string) => void): Promise<void> => {
		if (shutdownPromise) {
			return shutdownPromise;
		}

		const generation = beginStartupWorkGeneration();
		clearStartupTimers();
		shutdownPromise = (async () => {
			try {
				await accountManager.shutdown();
			} catch (error) {
				const message = `Failed to stop multi-auth background services: ${getErrorMessage(error)}`;
				multiAuthDebugLogger.log("session_shutdown_warning", {
					message,
					generation,
					error: getErrorMessage(error),
				});
				onWarning?.(message);
			} finally {
				unregisterGlobalKeyDistributor(keyDistributor);
			}
		})();
		return shutdownPromise;
	};

	const flushStartupWarnings = (notify?: (message: string) => void): void => {
		if (!notify) {
			return;
		}
		for (const warning of startupWarnings) {
			notify(warning);
		}
	};

	if (!isSubagentRuntime) {
		registerMultiAuthCommands(pi, accountManager);
	}

	try {
		await registerMultiAuthProviders(pi, accountManager, {
			excludeProviders: configLoadResult.config.excludeProviders,
			includeProviders:
				isSubagentRuntime && requestedSubagentProvider
					? [requestedSubagentProvider]
					: undefined,
		});
	} catch (error) {
		recordStartupWarning(
			`Failed to register provider wrappers: ${getErrorMessage(error)}`,
			"provider_registration",
			error,
		);
	}

	pi.on("session_start", (_event, ctx) => {
		const event = _event as SessionStartEvent;
		shutdownPromise = null;
		const startupGeneration = beginStartupWorkGeneration();
		clearStartupTimers();
		registerGlobalKeyDistributor(keyDistributor);
		flushStartupWarnings((message) => {
			ctx.ui.notify(`multi-auth startup warning: ${message}`, "warning");
		});

		// Refresh config on reload
		if (event.reason === "reload") {
			const reloadResult = loadMultiAuthConfig();
			if (reloadResult.warning) {
				ctx.ui.notify(`multi-auth reload warning: ${reloadResult.warning}`, "warning");
			}
			accountManager.refreshExtensionConfig(reloadResult.config);
			multiAuthDebugLogger.log("config_refreshed", { reason: event.reason });
		}

		if (!isSubagentRuntime) {
			scheduleStartupWork(startupGeneration, (message) => {
				ctx.ui.notify(`multi-auth initialization warning: ${message}`, "warning");
			});
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await shutdownExtension((message) => {
			if (ctx.hasUI) {
				ctx.ui.notify(`multi-auth shutdown warning: ${message}`, "warning");
			}
		});
	});
}
