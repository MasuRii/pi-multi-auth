import type { SupportedProviderId } from "./types.js";

/**
 * Normalized Codex plan types used for entitlement checks.
 */
export type CodexPlanType =
	| "free"
	| "plus"
	| "pro"
	| "team"
	| "business"
	| "enterprise"
	| "unknown";

/**
 * Result returned when model-specific credential eligibility has been resolved.
 */
export interface CredentialModelEligibility {
	appliesConstraint: boolean;
	eligibleCredentialIds: readonly string[];
	ineligibleCredentialIds: readonly string[];
	failureMessage?: string;
}

const OPENAI_CODEX_PAID_MODEL_IDS = new Set([
	"gpt-5-mini",
	"gpt-5.3-codex",
]);
const OPENAI_CODEX_PAID_MODEL_PATTERNS: readonly RegExp[] = [
	/^gpt-5\.(?:[4-9]|\d{2,})(?:-[a-z0-9]+)*$/,
];
const OPENAI_CODEX_PAID_PLAN_TYPES = new Set<CodexPlanType>([
	"plus",
	"pro",
	"team",
	"business",
	"enterprise",
]);

function normalizeProviderId(providerId: SupportedProviderId): SupportedProviderId {
	return providerId.trim().toLowerCase();
}

export function normalizeModelId(modelId: string | undefined): string | null {
	if (typeof modelId !== "string") {
		return null;
	}

	const normalized = modelId.trim().toLowerCase();
	if (!normalized) {
		return null;
	}

	const separatorIndex = normalized.indexOf("/");
	if (separatorIndex < 0) {
		return normalized;
	}

	const parsedModelId = normalized.slice(separatorIndex + 1).trim();
	return parsedModelId.length > 0 ? parsedModelId : null;
}

export function formatModelReference(
	providerId: SupportedProviderId,
	modelId: string,
): string {
	return `${normalizeProviderId(providerId)}/${modelId}`;
}

/**
 * Normalizes Codex plan labels from usage snapshots.
 */
export function normalizeCodexPlanType(planType: string | null | undefined): CodexPlanType {
	if (typeof planType !== "string") {
		return "unknown";
	}

	const normalized = planType.trim().toLowerCase();
	if (!normalized) {
		return "unknown";
	}

	const collapsed = normalized.replace(/^chatgpt(?:[\s_-]+)?/, "").replace(/[\s_-]+/g, "-");
	switch (collapsed) {
		case "free":
		case "plus":
		case "pro":
		case "team":
		case "business":
		case "enterprise":
			return collapsed;
		default:
			return "unknown";
	}
}

/**
 * Indicates whether a model currently requires a paid Codex plan.
 */
export function modelRequiresEntitlement(
	providerId: SupportedProviderId,
	modelId: string | undefined,
): boolean {
	if (normalizeProviderId(providerId) !== "openai-codex") {
		return false;
	}

	const normalizedModelId = normalizeModelId(modelId);
	if (!normalizedModelId) {
		return false;
	}

	return (
		OPENAI_CODEX_PAID_MODEL_IDS.has(normalizedModelId) ||
		OPENAI_CODEX_PAID_MODEL_PATTERNS.some((pattern) => pattern.test(normalizedModelId))
	);
}

/**
 * Checks if a Codex plan type is eligible for a paid model.
 */
export function isPlanEligibleForModel(planType: CodexPlanType): boolean {
	return OPENAI_CODEX_PAID_PLAN_TYPES.has(planType);
}