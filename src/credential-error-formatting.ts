import type { CredentialErrorKind } from "./error-classifier.js";

export function describeCredentialErrorAction(kind: CredentialErrorKind): string {
	switch (kind) {
		case "balance_exhausted":
			return "Add credits/funds to the provider account, then re-enable or retry this credential.";
		case "quota":
		case "quota_weekly":
			return "Wait for quota reset, increase the quota, or switch to another credential/provider.";
		case "rate_limit":
			return "Wait for the rate limit window to reset or switch to another credential/provider.";
		case "authentication":
			return "Check that the API key or OAuth credential is valid and has not expired.";
		case "permission":
			return "Check provider account permissions, model access, billing status, or organization access.";
		case "invalid_request":
			return "Check the selected model name and request compatibility for this provider.";
		case "context_limit":
			return "Reduce the prompt/context size or choose a model with a larger context window.";
		case "provider_transient":
		case "request_timeout":
			return "Retry later; the provider or network path appears temporarily unavailable.";
		case "organization_disabled":
			return "Restore or switch the disabled provider organization/account before retrying.";
		case "unknown":
			return "Review the provider response below, then retry with another credential/provider if needed.";
	}
}
