import { quotaClassifier } from "./quota-classifier.js";
import type { QuotaClassification, QuotaWindow, RecoveryAction } from "./types-quota.js";

export type CredentialErrorKind =
	| "rate_limit"
	| "quota"
	| "quota_weekly"
	| "balance_exhausted"
	| "authentication"
	| "permission"
	| "organization_disabled"
	| "context_limit"
	| "invalid_request"
	| "provider_transient"
	| "request_timeout"
	| "unknown";

export interface CredentialErrorClassification {
	kind: CredentialErrorKind;
	shouldRotateCredential: boolean;
	shouldRetrySameCredential: boolean;
	shouldApplyCooldown: boolean;
	shouldDisableCredential: boolean;
	reason: string;
	quotaClassification?: QuotaClassification;
	quotaWindow?: QuotaWindow;
	recommendedCooldownMs?: number;
	recoveryAction?: RecoveryAction;
}

export interface CredentialErrorContext {
	providerId?: string;
	modelId?: string;
}

const CONTEXT_LIMIT_PATTERNS: RegExp[] = [
	/context length/i,
	/context_length_exceeded/i,
	/maximum context/i,
	/max(?:imum)?\s+tokens?/i,
	/token limit/i,
	/prompt is too long/i,
	/input is too long/i,
	// Ollama context window patterns
	/context window/i,
	/num_ctx/i,
];

const AUTH_PATTERNS: RegExp[] = [
	/invalid[_-]?api[_-]?key/i,
	/incorrect\s+api\s+key/i,
	/invalid\s+auth(?:entication)?/i,
	/\b401\b/i,
	/unauthorized/i,
	/expired\s+(?:token|session|credential)/i,
	/access token expired/i,
];

const ORGANIZATION_DISABLED_PATTERNS: RegExp[] = [
	/this organization has been disabled/i,
	/organization has been disabled/i,
	/organization[^\n]*disabled/i,
	/invalid_request_error[^\n]*organization/i,
];

const PERMISSION_PATTERNS: RegExp[] = [
	/\b403\b/i,
	/forbidden/i,
	/permission[_\s-]?denied/i,
	/does not have permission/i,
	/must be a member of an organization/i,
];

const INVALID_REQUEST_PATTERNS: RegExp[] = [
	/\b400\b/i,
	/bad request/i,
	/unsupported endpoint or method/i,
	/unsupported[_\s-]?endpoint/i,
	/invalid[_\s-]?request/i,
	/unknown model/i,
	/unsupported model/i,
	/model[^\n]*(?:not found|not supported)/i,
	/unknown parameter/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
	/\b429\b/i,
	/too many requests/i,
	/rate\s*-?\s*limit(?:ed|s)?/i,
	/rate_limit_(?:error|exceeded)/i,
	/throttl(?:ed|ing)?/i,
	/secondary rate limit/i,
	/requests? per (?:minute|second|hour)/i,
	// Ollama server/slot saturation patterns
	/server\s+(?:is\s+)?busy/i,
	/no\s+available\s+slots?/i,
	/all\s+slots?\s+(?:are\s+)?busy/i,
	/too\s+many\s+concurrent/i,
];

const QUOTA_PATTERNS: RegExp[] = [
	/insufficient[_-]?quota/i,
	/exceeded your current quota/i,
	/quota exceeded/i,
	/usage limit/i,
	/credit balance/i,
	/out of credits?/i,
	/monthly (?:spend|usage) limit/i,
	/resource\s*exhausted/i,
	/RESOURCE_EXHAUSTED/,
	/limit[_\s-]?reached/i,
	// Ollama resource exhaustion patterns
	/out\s+of\s+memory/i,
	/CUDA[\s_]out[\s_]of[\s_]memory/i,
	/\bOOM\b/,
];

/**
 * Patterns indicating balance exhaustion that requires manual intervention to restore.
 * These credentials should be DISABLED (not just cooled down) because the account
 * has no credits/balance and requires manual action to add funds.
 * Examples: "outstanding_balance", "insufficient balance", "no credits remaining"
 */
const BALANCE_EXHAUSTED_PATTERNS: RegExp[] = [
	/outstanding[_\s-]?balance/i,
	/balance[_\s-]?too[_\s-]?low/i,
	/insufficient[_\s-]?balance/i,
	/no[_\s-]?credits?[_\s-]?(?:remaining|left)/i,
	/account[_\s-]?has[_\s-]?no[_\s-]?credits/i,
	/credits?[_\s-]?depleted/i,
	/balance[_\s-]?depleted/i,
	/please[_\s-]?add[_\s-]?credits/i,
	/please[_\s-]?add[_\s-]?funds/i,
];

/**
 * Patterns indicating a weekly/quota reset cycle that requires longer cooldown.
 * These are permanent exhaustion until the weekly reset, not temporary rate limits.
 * Examples: "you have reached your weekly usage limit", "7-day window"
 */
const WEEKLY_QUOTA_PATTERNS: RegExp[] = [
	/weekly\s+(?:usage|credit|limit)/i,
	/your\s+weekly/i,
	/reached your weekly/i,
	/\bweekly\b[^\n.]*\blimit\b/i,
	/\bweekly\b[^\n.]*\bquota\b/i,
	/7-?day\s+(?:limit|window)/i,
	/upgrade for higher limits/i,
];

const REQUEST_TIMEOUT_PATTERNS: RegExp[] = [
	/multi-auth stream timeout/i,
	/\b(?:attempt|idle)_timeout\b/i,
	/stream timed out/i,
	/request timed out/i,
];

const TRANSIENT_PROVIDER_PATTERNS: RegExp[] = [
	/\b5\d\d\b/i,
	/internal[_\s-]?server[_\s-]?error/i,
	/internal_server_error/i,
	/service unavailable/i,
	/bad gateway/i,
	/gateway timeout/i,
	/upstream[^\n]*(?:timeout|error|failed|unavailable)/i,
	/temporar(?:y|ily) unavailable/i,
	/please try again later/i,
	/timeout/i,
	/timed out/i,
	/ECONNRESET/i,
	/ECONNREFUSED/i,
	/ETIMEDOUT/i,
	/socket hang up/i,
	/network error/i,
	/fetch failed/i,
	/request was aborted/i,
	/operation was aborted/i,
	/\bAbortError\b/i,
	/ended (?:before|without) completion/i,
	/without completion event/i,
	/stream ended unexpectedly/i,
	// Ollama model lifecycle/runner patterns
	/model\s+(?:is\s+)?not\s+loaded/i,
	/failed\s+to\s+load\s+model/i,
	/llama\s+runner/i,
];

const MODEL_NOT_SUPPORTED_PATTERNS: RegExp[] = [
	/unsupported model/i,
	/model[^\n]*(?:not found|not supported)/i,
	/unknown model/i,
];

function matchesAny(message: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(message));
}

function withQuotaClassification(
	message: string,
	classification: CredentialErrorClassification,
): CredentialErrorClassification {
	if (
		classification.kind !== "rate_limit" &&
		classification.kind !== "quota" &&
		classification.kind !== "quota_weekly" &&
		classification.kind !== "balance_exhausted" &&
		classification.kind !== "organization_disabled"
	) {
		return classification;
	}

	const quotaResult = quotaClassifier.classifyFromMessage(message);
	return {
		...classification,
		quotaClassification: quotaResult.classification,
		quotaWindow: quotaResult.window,
		recommendedCooldownMs: quotaResult.cooldownMs,
		recoveryAction: quotaResult.recoveryAction,
	};
}

export function isRetryableModelAvailabilityError(
	errorText: string,
	context?: CredentialErrorContext,
): boolean {
	const message = errorText.trim();
	if (!message) {
		return false;
	}

	if ((context?.providerId ?? "").trim().toLowerCase() !== "vivgrid") {
		return false;
	}

	return matchesAny(message, MODEL_NOT_SUPPORTED_PATTERNS);
}

export function classifyCredentialError(
	rawMessage: string,
	context?: CredentialErrorContext,
): CredentialErrorClassification {
	const message = rawMessage.trim();
	if (!message) {
		return {
			kind: "unknown",
			shouldRotateCredential: false,
			shouldRetrySameCredential: false,
			shouldApplyCooldown: false,
			shouldDisableCredential: false,
			reason: "Empty error message",
		};
	}

	if (matchesAny(message, CONTEXT_LIMIT_PATTERNS)) {
		return {
			kind: "context_limit",
			shouldRotateCredential: false,
			shouldRetrySameCredential: false,
			shouldApplyCooldown: false,
			shouldDisableCredential: false,
			reason: "Context/token limit error detected",
		};
	}

	if (matchesAny(message, AUTH_PATTERNS)) {
		return {
			kind: "authentication",
			shouldRotateCredential: true,
			shouldRetrySameCredential: false,
			shouldApplyCooldown: false,
			shouldDisableCredential: false,
			reason: "Authentication error detected",
		};
	}

	if (matchesAny(message, ORGANIZATION_DISABLED_PATTERNS)) {
		return withQuotaClassification(message, {
			kind: "organization_disabled",
			shouldRotateCredential: true,
			shouldRetrySameCredential: false,
			shouldApplyCooldown: false,
			shouldDisableCredential: true,
			reason: "Organization is disabled for this credential",
		});
	}

	// Balance exhaustion requires manual intervention (add credits/funds)
	// These credentials should be DISABLED and only re-enabled manually
	if (matchesAny(message, BALANCE_EXHAUSTED_PATTERNS)) {
		return withQuotaClassification(message, {
			kind: "balance_exhausted",
			shouldRotateCredential: true,
			shouldRetrySameCredential: false,
			shouldApplyCooldown: false,
			shouldDisableCredential: true,
			reason: "Account balance exhausted - credential disabled until manually re-enabled",
		});
	}

	if (matchesAny(message, PERMISSION_PATTERNS)) {
		return {
			kind: "permission",
			shouldRotateCredential: true,
			shouldRetrySameCredential: false,
			shouldApplyCooldown: false,
			shouldDisableCredential: false,
			reason: "Permission error detected",
		};
	}

	if (isRetryableModelAvailabilityError(message, context)) {
		return {
			kind: "invalid_request",
			shouldRotateCredential: true,
			shouldRetrySameCredential: false,
			shouldApplyCooldown: false,
			shouldDisableCredential: false,
			reason: "Provider reported the requested model is unavailable on this vivgrid credential",
		};
	}

	if (matchesAny(message, INVALID_REQUEST_PATTERNS)) {
		return {
			kind: "invalid_request",
			shouldRotateCredential: false,
			shouldRetrySameCredential: false,
			shouldApplyCooldown: false,
			shouldDisableCredential: false,
			reason: "Invalid or unsupported request detected",
		};
	}

	const isRateLimited = matchesAny(message, RATE_LIMIT_PATTERNS);
	const isQuotaError = matchesAny(message, QUOTA_PATTERNS);
	const isWeeklyQuota = matchesAny(message, WEEKLY_QUOTA_PATTERNS);

	// Weekly quota errors get special handling with exponential backoff
	if (isWeeklyQuota) {
		return withQuotaClassification(message, {
			kind: "quota_weekly",
			shouldRotateCredential: true,
			shouldRetrySameCredential: false,
			shouldApplyCooldown: true,
			shouldDisableCredential: false,
			reason: "Weekly quota exhaustion detected - requires exponential backoff",
		});
	}

	if (isRateLimited || isQuotaError) {
		return withQuotaClassification(message, {
			kind: isQuotaError ? "quota" : "rate_limit",
			shouldRotateCredential: true,
			shouldRetrySameCredential: false,
			shouldApplyCooldown: true,
			shouldDisableCredential: false,
			reason: isQuotaError
				? "Quota or spend exhaustion pattern detected"
				: "Rate-limit pattern detected",
		});
	}

	if (matchesAny(message, REQUEST_TIMEOUT_PATTERNS)) {
		return {
			kind: "request_timeout",
			shouldRotateCredential: false,
			shouldRetrySameCredential: true,
			shouldApplyCooldown: false,
			shouldDisableCredential: false,
			reason: "Per-attempt request timeout detected",
		};
	}

	if (matchesAny(message, TRANSIENT_PROVIDER_PATTERNS)) {
		return {
			kind: "provider_transient",
			shouldRotateCredential: false,
			shouldRetrySameCredential: true,
			shouldApplyCooldown: false,
			shouldDisableCredential: false,
			reason: "Transient provider/server error detected",
		};
	}

	return {
		kind: "unknown",
		shouldRotateCredential: false,
		shouldRetrySameCredential: false,
		shouldApplyCooldown: false,
		shouldDisableCredential: false,
		reason: "No known rotation pattern matched",
	};
}

/**
 * Lightweight check for quota or rate-limit errors without the full classification.
 * Designed for external consumers (e.g. pi-agent-router) that only need to detect
 * quota/rate-limit failures from subagent stderr output.
 */
export function isQuotaOrRateLimitError(errorText: string): boolean {
	const text = errorText.trim();
	if (!text) {
		return false;
	}
	return (
		matchesAny(text, RATE_LIMIT_PATTERNS) ||
		matchesAny(text, QUOTA_PATTERNS) ||
		matchesAny(text, WEEKLY_QUOTA_PATTERNS) ||
		matchesAny(text, BALANCE_EXHAUSTED_PATTERNS)
	);
}
