export interface TokenExpiration {
	credentialId: string;
	providerId: string;
	expiresAt: number;
	safetyWindowMs: number;
	refreshAt: number;
	source: "jwt_exp" | "expires_in" | "expires_at" | "default";
}

export interface OAuthRefreshConfig {
	safetyWindowMs: number;
	minRefreshWindowMs: number;
	checkIntervalMs: number;
	maxConcurrentRefreshes: number;
	requestTimeoutMs: number;
	enabled: boolean;
	excludedProviders: string[];
}

export const DEFAULT_OAUTH_CONFIG: OAuthRefreshConfig = {
	safetyWindowMs: 60_000,
	minRefreshWindowMs: 30_000,
	checkIntervalMs: 60_000,
	maxConcurrentRefreshes: 3,
	requestTimeoutMs: 15_000,
	enabled: true,
	excludedProviders: [],
};

export interface RefreshResult {
	credentialId: string;
	success: boolean;
	newExpiresAt?: number;
	error?: string;
	attemptedAt: number;
}

export interface ScheduledRefresh {
	credentialId: string;
	providerId: string;
	scheduledAt: number;
	isPending: boolean;
	attempts: number;
}

export type OAuthRefreshFailureSource = "extension" | "provider";

export const UNSUPPORTED_OAUTH_REFRESH_PROVIDER_ERROR_CODE = "unsupported_refresh_provider";

export interface OAuthRefreshFailureDetails {
	providerId: string;
	credentialId?: string;
	status?: number;
	errorCode?: string;
	reason?: string;
	permanent: boolean;
	source: OAuthRefreshFailureSource;
}

export class OAuthRefreshFailureError extends Error {
	readonly details: OAuthRefreshFailureDetails;

	constructor(
		message: string,
		details: OAuthRefreshFailureDetails,
		options?: { cause?: unknown },
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "OAuthRefreshFailureError";
		this.details = { ...details };
	}
}

export function isOAuthRefreshFailureError(
	error: unknown,
): error is OAuthRefreshFailureError {
	return error instanceof OAuthRefreshFailureError;
}
