import type { ProviderCascadeState } from "./types-cascade.js";
import type { ProviderHealthState } from "./types-health.js";
import type { ProviderPoolState } from "./types-pool.js";
import type { SupportedProviderId } from "./types.js";
import { usageProviders } from "./usage/providers.js";

export type ProviderRotationProfile = "standard" | "lightweight";

export interface ProviderRotationClassification {
	hasExternalAccountState: boolean;
	rotationProfile: ProviderRotationProfile;
}

export interface LightweightSelectionUpdate {
	providerId: SupportedProviderId;
	credentialIds: readonly string[];
	credentialId: string;
	selectedIndex: number;
	nextActiveIndex: number;
	selectedAt: number;
	poolState?: ProviderPoolState;
	incrementUsage?: boolean;
}

export interface LightweightTelemetryUpdate {
	providerId: SupportedProviderId;
	credentialIds: readonly string[];
	cascadeState?: Record<string, ProviderCascadeState>;
	healthState?: ProviderHealthState;
}

const EXTERNAL_ACCOUNT_STATE_PROVIDER_IDS = new Set(usageProviders.map((provider) => provider.id));

export function resolveProviderRotationClassification(
	providerId: SupportedProviderId,
	options: { supportsOAuth: boolean },
): ProviderRotationClassification {
	const normalizedProviderId = providerId.trim();
	const hasExternalAccountState = EXTERNAL_ACCOUNT_STATE_PROVIDER_IDS.has(normalizedProviderId);
	return {
		hasExternalAccountState,
		rotationProfile:
			!options.supportsOAuth && !hasExternalAccountState ? "lightweight" : "standard",
	};
}
