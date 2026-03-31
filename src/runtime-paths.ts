import { homedir } from "node:os";
import { join, resolve } from "node:path";

function normalizeRuntimeRoot(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	return trimmed ? resolve(trimmed) : null;
}

export function getAgentRuntimeRoot(): string {
	return normalizeRuntimeRoot(process.env.PI_CODING_AGENT_DIR) ?? join(homedir(), ".pi", "agent");
}

export function resolveAgentRuntimePath(...segments: string[]): string {
	return join(getAgentRuntimeRoot(), ...segments);
}
