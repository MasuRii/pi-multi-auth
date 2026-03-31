import type { Api, AssistantMessage } from "@mariozechner/pi-ai";
import type { OAuthCredentials } from "./oauth-compat.js";
import type { ProviderCascadeState } from "./types-cascade.js";
import type { FailoverChain, FailoverChainState } from "./types-failover.js";
import type { ProviderHealthState } from "./types-health.js";
import type { CredentialPool, ProviderPoolConfig, ProviderPoolState } from "./types-pool.js";
import type { QuotaStateForCredential } from "./types-quota.js";
import type { UsageSnapshot } from "./usage/types.js";

/**
 * Legacy providers retained as seed/fallback values for migration and discovery.
 */
export const LEGACY_SUPPORTED_PROVIDERS = [
	"openai-codex",
	"github-copilot",
	"anthropic",
	"google-gemini-cli",
	"google-antigravity",
] as const;

/** Provider IDs handled by pi-multi-auth. */
export type SupportedProviderId = string;

/** Rotation strategies for selecting credentials. */
export type RotationMode = "round-robin" | "usage-based" | "balancer";

/** OAuth credential payload stored in auth.json entries. */
export type StoredOAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

/** API key payload stored in auth.json entries. */
export interface StoredApiKeyCredential {
	type: "api_key";
	key: string;
}

/** Any credential payload stored in auth.json. */
export type StoredAuthCredential = StoredOAuthCredential | StoredApiKeyCredential;

/** Full auth.json structure. */
export type AuthFileData = Record<string, StoredAuthCredential>;

/** Per-provider rotation state persisted in multi-auth.json. */
export interface ProviderRotationState {
	credentialIds: string[];
	activeIndex: number;
	rotationMode: RotationMode;
	manualActiveCredentialId?: string;
	lastUsedAt: Record<string, number>;
	usageCount: Record<string, number>;
	quotaErrorCount: Record<string, number>;
	quotaExhaustedUntil: Record<string, number>;
	/** Last error message per credential, used to show users why a credential is exhausted. */
	lastQuotaError: Record<string, string>;
	/** Last transient provider/transport error per credential, used to explain cooldowns. */
	lastTransientError: Record<string, string>;
	/** Consecutive transient provider failures per credential, used for exponential backoff. */
	transientErrorCount: Record<string, number>;
	/** Consecutive weekly quota failures per credential, used for exponential backoff. */
	weeklyQuotaAttempts: Record<string, number>;
	friendlyNames: Record<string, string>;
	/** Permanently disabled credentials that require manual re-enablement.
	 * Key is credentialId, value contains the error message and timestamp when disabled.
	 * Used for balance exhaustion and other unrecoverable errors.
	 */
	disabledCredentials: Record<string, { error: string; disabledAt: number }>;
	/** Persisted cascade retry state keyed by provider ID. */
	cascadeState?: Record<string, ProviderCascadeState>;
	/** Persisted credential health scores and request history. */
	healthState?: ProviderHealthState;
	/** Scheduled OAuth refresh timestamps keyed by credential ID. */
	oauthRefreshScheduled?: Record<string, number>;
	/** @experimental Optional pool definitions for this provider. */
	pools?: CredentialPool[];
	/** @experimental Provider-level pool selection settings. */
	poolConfig?: ProviderPoolConfig;
	/** @experimental Pool rotation state when pools are configured. */
	poolState?: ProviderPoolState;
	/** @experimental Cross-provider failover chains that include this provider. */
	chains?: FailoverChain[];
	/** @experimental Active failover state shared across linked providers. */
	activeChain?: FailoverChainState;
	/** Richer quota classifications keyed by credential ID. */
	quotaStates?: Record<string, QuotaStateForCredential>;
}

/** UI preferences persisted in multi-auth.json. */
export interface MultiAuthUiState {
	hiddenProviders: string[];
}

/** Top-level multi-auth.json shape. */
export interface MultiAuthState {
	version: 1;
	providers: Record<string, ProviderRotationState>;
	ui: MultiAuthUiState;
}

/** Credential kind shown in status output. */
export type CredentialType = StoredAuthCredential["type"];

/** Selected credential used to execute a provider request. */
export interface SelectedCredential {
	provider: SupportedProviderId;
	credentialId: string;
	credential: StoredAuthCredential;
	secret: string;
	index: number;
}

/** Readable credential status for command output. */
export interface CredentialStatus {
	credentialId: string;
	credentialType: CredentialType;
	redactedSecret: string;
	friendlyName?: string;
	index: number;
	isActive: boolean;
	isManualActive?: boolean;
	expiresAt: number | null;
	isExpired: boolean;
	quotaExhaustedUntil?: number;
	usageCount: number;
	/** Count of generic quota errors (hourly/daily resets). */
	quotaErrorCount: number;
	/** Count of consecutive transient provider failures (used for exponential backoff). */
	transientErrorCount?: number;
	/** Count of consecutive weekly quota errors (used for exponential backoff). */
	weeklyQuotaAttempts?: number;
	/** Last quota error message for this credential. */
	lastQuotaError?: string;
	/** Last transient provider error for this credential. */
	lastTransientError?: string;
	lastUsedAt?: number;
	usageSnapshot?: UsageSnapshot | null;
	usageFetchError?: string;
	disabledError?: string;
}

/** Readable provider status for command output. */
export interface ProviderStatus {
	provider: SupportedProviderId;
	rotationMode: RotationMode;
	activeIndex: number;
	manualActiveCredentialId?: string;
	credentials: CredentialStatus[];
}

/** Normalized model definition used for provider registration. */
export interface ProviderModelDefinition {
	id: string;
	name: string;
	api?: Api;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
}

/** Provider metadata required for wrapper registration. */
export interface ProviderRegistrationMetadata {
	provider: SupportedProviderId;
	/** Primary API type for this provider. */
	api: Api;
	/** All unique API types used by models in this provider. */
	apis: Api[];
	baseUrl: string;
	models: ProviderModelDefinition[];
}

/** Helper to construct an assistant error response. */
export interface AssistantErrorFactoryInput {
	provider: string;
	api: Api;
	model: string;
	message: string;
}

/** Auth writer result for backup credential creation flows. */
export interface BackupAndStoreResult {
	credentialId: string;
	isBackupCredential: boolean;
	credentialIds: string[];
	didAddCredential?: boolean;
	duplicateOfCredentialId?: string;
	deduplicatedCount?: number;
	renumberedCredentialIds?: boolean;
}

/** Minimal assistant usage object for synthetic errors. */
export interface EmptyAssistantUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/** Synthetic assistant error message shape. */
export type AssistantErrorMessage = AssistantMessage & {
	stopReason: "error";
	errorMessage: string;
};
