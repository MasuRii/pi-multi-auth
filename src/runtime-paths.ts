import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";

export function getAgentRuntimeRoot(): string {
	return getAgentDir();
}

export function resolveAgentRuntimePath(...segments: string[]): string {
	return join(getAgentRuntimeRoot(), ...segments);
}
