const REMOVED_GOOGLE_PROVIDER_IDS = new Set([
	["google", "gemini", "cli"].join("-"),
	["google", "antigravity"].join("-"),
]);

export function isRemovedLegacyGoogleProvider(providerId: string | undefined): boolean {
	const normalizedProviderId = providerId?.trim().toLowerCase();
	return normalizedProviderId !== undefined && REMOVED_GOOGLE_PROVIDER_IDS.has(normalizedProviderId);
}
