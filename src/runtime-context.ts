import type { SupportedProviderId } from "./types.js";

export const PI_AGENT_ROUTER_SUBAGENT_ENV = "PI_AGENT_ROUTER_SUBAGENT";
export const PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID_ENV = "PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID";
export const PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID_ENV = "PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID";
export const PI_AGENT_ROUTER_DELEGATED_API_KEY_ENV = "PI_AGENT_ROUTER_DELEGATED_API_KEY";

export interface DelegatedCredentialOverride {
	providerId: SupportedProviderId;
	credentialId: string;
	apiKey: string;
}

function normalizeProviderId(providerId: string | undefined): SupportedProviderId | undefined {
	if (typeof providerId !== "string") {
		return undefined;
	}

	const normalized = providerId.trim().toLowerCase();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const normalized = value.trim();
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

export function resolveDelegatedCredentialOverride(
	providerId?: SupportedProviderId,
	env: NodeJS.ProcessEnv = process.env,
): DelegatedCredentialOverride | undefined {
	if (!isDelegatedSubagentRuntime(env)) {
		return undefined;
	}

	const delegatedProviderId = normalizeProviderId(env[PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID_ENV]);
	const expectedProviderId = normalizeProviderId(providerId);
	if (!delegatedProviderId) {
		return undefined;
	}
	if (expectedProviderId && delegatedProviderId !== expectedProviderId) {
		return undefined;
	}

	const credentialId = normalizeEnvValue(env[PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID_ENV]);
	const apiKey = normalizeEnvValue(env[PI_AGENT_ROUTER_DELEGATED_API_KEY_ENV]);
	if (!credentialId || !apiKey) {
		return undefined;
	}

	return {
		providerId: delegatedProviderId,
		credentialId,
		apiKey,
	};
}
