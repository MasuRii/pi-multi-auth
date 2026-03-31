import type { SupportedProviderId } from "./types.js";

export const PI_AGENT_ROUTER_SUBAGENT_ENV = "PI_AGENT_ROUTER_SUBAGENT";

function normalizeProviderId(providerId: string | undefined): SupportedProviderId | undefined {
	if (typeof providerId !== "string") {
		return undefined;
	}

	const normalized = providerId.trim().toLowerCase();
	return normalized.length > 0 ? normalized : undefined;
}

function parseProviderFromModelReference(modelReference: string | undefined): SupportedProviderId | undefined {
	if (typeof modelReference !== "string") {
		return undefined;
	}

	const normalized = modelReference.trim();
	if (!normalized) {
		return undefined;
	}

	const separatorIndex = normalized.indexOf("/");
	if (separatorIndex <= 0) {
		return normalizeProviderId(normalized);
	}

	return normalizeProviderId(normalized.slice(0, separatorIndex));
}

export function isDelegatedSubagentRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[PI_AGENT_ROUTER_SUBAGENT_ENV] === "1";
}

export function resolveRequestedProviderFromArgv(
	argv: readonly string[] = process.argv,
): SupportedProviderId | undefined {
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--model") {
			return parseProviderFromModelReference(argv[index + 1]);
		}

		if (argument.startsWith("--model=")) {
			return parseProviderFromModelReference(argument.slice("--model=".length));
		}
	}

	return undefined;
}
