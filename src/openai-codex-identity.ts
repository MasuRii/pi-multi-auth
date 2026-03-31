const OPENAI_AUTH_CLAIM_KEY = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM_KEY = "https://api.openai.com/profile";

export interface CodexCredentialIdentitySource {
	access: string;
	accountId?: unknown;
}

export interface CodexCredentialIdentity {
	accountUserId: string | null;
	email: string | null;
	accountId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
	if (!token) {
		return null;
	}

	const parts = token.split(".");
	const payloadPart = parts[1];
	if (!payloadPart) {
		return null;
	}

	const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
	const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;

	try {
		const decoded = Buffer.from(padded, "base64").toString("utf-8");
		const parsed = JSON.parse(decoded) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function extractCodexCredentialIdentity(
	credential: CodexCredentialIdentitySource,
): CodexCredentialIdentity {
	const payload = decodeJwtPayload(credential.access);
	const authClaimRaw = payload?.[OPENAI_AUTH_CLAIM_KEY];
	const profileClaimRaw = payload?.[OPENAI_PROFILE_CLAIM_KEY];
	const authClaim = isRecord(authClaimRaw) ? authClaimRaw : null;
	const profileClaim = isRecord(profileClaimRaw) ? profileClaimRaw : null;

	return {
		accountUserId:
			asNonEmptyString(authClaim?.chatgpt_account_user_id) ??
			asNonEmptyString(authClaim?.chatgpt_user_id) ??
			asNonEmptyString(authClaim?.user_id),
		email: asNonEmptyString(profileClaim?.email),
		accountId:
			asNonEmptyString(credential.accountId) ??
			asNonEmptyString(authClaim?.chatgpt_account_id),
	};
}
