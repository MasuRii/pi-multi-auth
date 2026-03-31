import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { AccountManager } from "./account-manager.js";
import {
	registerGlobalKeyDistributor,
	unregisterGlobalKeyDistributor,
} from "./balancer/index.js";
import { registerMultiAuthCommands } from "./commands.js";
import { loadMultiAuthConfig } from "./config.js";
import { multiAuthDebugLogger } from "./debug-logger.js";
import { registerMultiAuthProviders } from "./provider.js";
import {
	isDelegatedSubagentRuntime,
	resolveRequestedProviderFromArgv,
} from "./runtime-context.js";

const STARTUP_WARMUP_DELAY_MS = 0;
const STARTUP_REFINEMENT_DELAY_MS = 1_500;

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * pi-multi-auth extension entry point for multi-account OAuth credential management and rotation.
 */
export default async function multiAuthExtension(pi: ExtensionAPI): Promise<void> {
	const configLoadResult = loadMultiAuthConfig();
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

	const scheduleRefinement = (onError?: (message: string) => void): void => {
		if (refinementInFlight || refinementTimer) {
			return;
		}

		refinementTimer = setTimeout(() => {
			refinementTimer = null;
			if (warmupInFlight) {
				scheduleRefinement(onError);
				return;
			}

			refinementInFlight = accountManager
				.autoActivatePreferredCredentials()
				.catch((error: unknown) => {
					recordStartupWarning(
						getErrorMessage(error),
						"startup_refinement",
						error,
						onError,
					);
				})
				.finally(() => {
					refinementInFlight = null;
				});
		}, STARTUP_REFINEMENT_DELAY_MS);
	};

	const startWarmup = (onError?: (message: string) => void): void => {
		if (warmupInFlight) {
			return;
		}

		warmupInFlight = (async () => {
			await accountManager.ensureInitialized();
			await accountManager.autoActivatePreferredCredentials({ avoidUsageApi: true });
		})()
			.then(() => {
				warmupCompleted = true;
				scheduleRefinement(onError);
			})
			.catch((error: unknown) => {
				recordStartupWarning(
					getErrorMessage(error),
					"startup_warmup",
					error,
					onError,
				);
			})
			.finally(() => {
				warmupInFlight = null;
			});
	};

	const scheduleWarmup = (onError?: (message: string) => void): void => {
		if (warmupInFlight || warmupTimer) {
			return;
		}

		warmupTimer = setTimeout(() => {
			warmupTimer = null;
			startWarmup(onError);
		}, STARTUP_WARMUP_DELAY_MS);
	};

	const scheduleStartupWork = (onError?: (message: string) => void): void => {
		if (!warmupCompleted) {
			scheduleWarmup(onError);
			return;
		}
		scheduleRefinement(onError);
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
			streamTimeouts: configLoadResult.config.streamTimeouts,
		});
	} catch (error) {
		recordStartupWarning(
			`Failed to register provider wrappers: ${getErrorMessage(error)}`,
			"provider_registration",
			error,
		);
	}

	pi.on("session_start", (_event, ctx) => {
		registerGlobalKeyDistributor(keyDistributor);
		flushStartupWarnings((message) => {
			ctx.ui.notify(`multi-auth startup warning: ${message}`, "warning");
		});
		if (!isSubagentRuntime) {
			scheduleStartupWork((message) => {
				ctx.ui.notify(`multi-auth initialization warning: ${message}`, "warning");
			});
		}
	});

	pi.on("session_shutdown", () => {
		if (warmupTimer !== null) {
			clearTimeout(warmupTimer);
			warmupTimer = null;
		}
		if (refinementTimer !== null) {
			clearTimeout(refinementTimer);
			refinementTimer = null;
		}
		accountManager.shutdown();
		unregisterGlobalKeyDistributor(keyDistributor);
	});
}
