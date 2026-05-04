const CLOUDFLARE_WORKERS_AI_PROVIDER_IDS = new Set([
	"cloudflare",
	"cloudflare-workers-ai",
]);

const CLOUDFLARE_CREDENTIAL_MANAGED_AUTH_PROVIDER_IDS = new Set([
	...CLOUDFLARE_WORKERS_AI_PROVIDER_IDS,
	"cloudflare-ai-gateway",
]);

export function normalizeCloudflareProviderId(provider: string): string {
	return provider.trim().toLowerCase();
}

export function isCloudflareWorkersAiProvider(provider: string): boolean {
	return CLOUDFLARE_WORKERS_AI_PROVIDER_IDS.has(normalizeCloudflareProviderId(provider));
}

export function isCloudflareCredentialManagedAuthProvider(provider: string): boolean {
	return CLOUDFLARE_CREDENTIAL_MANAGED_AUTH_PROVIDER_IDS.has(
		normalizeCloudflareProviderId(provider),
	);
}
