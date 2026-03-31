import type { RotationMode, SupportedProviderId } from "./types.js";

const PROVIDER_DEFAULT_ROTATION_MODES: Partial<Record<SupportedProviderId, RotationMode>> = {
	"openai-codex": "usage-based",
};

const STANDARD_ROTATION_MODES: RotationMode[] = ["round-robin", "usage-based"];
const BALANCER_MODE: RotationMode = "balancer";

export function resolveDefaultRotationMode(provider: SupportedProviderId): RotationMode {
	return PROVIDER_DEFAULT_ROTATION_MODES[provider] ?? "round-robin";
}

export function formatRotationModeLabel(rotationMode: RotationMode): string {
	switch (rotationMode) {
		case "round-robin":
			return "Round-Robin Rotation";
		case "usage-based":
			return "Usage-Based Rotation";
		case "balancer":
			return "Balancer Rotation";
		default:
			return "Round-Robin Rotation";
	}
}

export function resolveSelectableRotationModes(
	currentMode: RotationMode,
	balancerAvailable: boolean,
): RotationMode[] {
	const modes = [...STANDARD_ROTATION_MODES];
	if (balancerAvailable || currentMode === BALANCER_MODE) {
		modes.push(BALANCER_MODE);
	}
	return modes;
}