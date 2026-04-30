import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";

export const PI_MULTI_AUTH_RUNTIME_DIR_ENV = "PI_MULTI_AUTH_RUNTIME_DIR";
const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function normalizeEnvPath(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

export function getAgentRuntimeRoot(): string {
	const delegatedRuntimeDir = normalizeEnvPath(process.env[PI_MULTI_AUTH_RUNTIME_DIR_ENV]);
	if (delegatedRuntimeDir) {
		return delegatedRuntimeDir;
	}

	const configuredAgentDir = normalizeEnvPath(process.env[PI_CODING_AGENT_DIR_ENV]);
	if (configuredAgentDir) {
		return configuredAgentDir;
	}

	const homeDir = normalizeEnvPath(process.env.HOME) ?? normalizeEnvPath(process.env.USERPROFILE);
	if (homeDir) {
		return join(homeDir, ".pi", "agent");
	}

	return getAgentDir();
}

export function resolveAgentRuntimePath(...segments: string[]): string {
	return join(getAgentRuntimeRoot(), ...segments);
}
