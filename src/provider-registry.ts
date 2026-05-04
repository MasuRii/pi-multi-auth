import { readFile, stat } from "node:fs/promises";
import { getModels, getProviders, type Api, type Model } from "@mariozechner/pi-ai";
import { getOAuthProvider, getOAuthProviders } from "./oauth-compat.js";
import { registerClineOAuthProvider } from "./oauth-cline.js";
import { registerKiloOAuthProvider } from "./oauth-kilo.js";
import { AuthWriter } from "./auth-writer.js";
import { isRemovedLegacyGoogleProvider } from "./removed-google-providers.js";
import {
	resolveProviderRotationClassification,
	type ProviderRotationProfile,
} from "./provider-rotation-profile.js";
import { resolveAgentRuntimePath } from "./runtime-paths.js";
import {
	LEGACY_SUPPORTED_PROVIDERS,
	type ProviderModelDefinition,
	type ProviderRegistrationMetadata,
	type SupportedProviderId,
} from "./types.js";
import { isRecord } from "./auth-error-utils.js";

interface ModelsProviderEntry {
	api: Api;
	baseUrl: string;
	models: ProviderModelDefinition[];
}

interface ModelsFileData {
	providers: Record<string, ModelsProviderEntry>;
}

interface ModelsFileCacheEntry {
	cacheKey: string;
	data: ModelsFileData;
}

export interface ProviderCapabilities {
	provider: SupportedProviderId;
	supportsApiKey: boolean;
	supportsOAuth: boolean;
	hasExternalAccountState: boolean;
	rotationProfile: ProviderRotationProfile;
}

export interface AvailableOAuthProvider {
	provider: SupportedProviderId;
	name: string;
}

export interface AvailableApiKeyProvider {
	provider: SupportedProviderId;
	name: string;
}

const API_KEY_LOGIN_PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
	anthropic: "Anthropic",
	"amazon-bedrock": "Amazon Bedrock",
	"azure-openai-responses": "Azure OpenAI Responses",
	cerebras: "Cerebras",
	cloudflare: "Cloudflare Workers AI",
	"cloudflare-workers-ai": "Cloudflare Workers AI",
	"cloudflare-ai-gateway": "Cloudflare AI Gateway",
	deepseek: "DeepSeek",
	fireworks: "Fireworks",
	google: "Google Gemini",
	"google-vertex": "Google Vertex AI",
	groq: "Groq",
	huggingface: "Hugging Face",
	"kimi-coding": "Kimi For Coding",
	mistral: "Mistral",
	minimax: "MiniMax",
	"minimax-cn": "MiniMax (China)",
	opencode: "OpenCode Zen",
	"opencode-go": "OpenCode Go",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	"vercel-ai-gateway": "Vercel AI Gateway",
	xai: "xAI",
	xiaomi: "Xiaomi MiMo",
	zai: "ZAI",
};

const BUILT_IN_API_KEY_LOGIN_PROVIDER_IDS = new Set(
	Object.keys(API_KEY_LOGIN_PROVIDER_DISPLAY_NAMES),
);

const EMPTY_MODELS_FILE: ModelsFileData = {
	providers: {},
};

const FIRST_CLASS_OAUTH_PROVIDER_REGISTRARS: Record<string, () => void> = {
	cline: registerClineOAuthProvider,
	kilo: registerKiloOAuthProvider,
};

const THINKING_LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function ensureProviderOAuthRegistration(provider: SupportedProviderId): void {
	const registerProvider = FIRST_CLASS_OAUTH_PROVIDER_REGISTRARS[provider];
	if (registerProvider && !getOAuthProvider(provider as Parameters<typeof getOAuthProvider>[0])) {
		registerProvider();
	}
}

function ensureFirstClassOAuthRegistrations(): void {
	for (const provider of Object.keys(FIRST_CLASS_OAUTH_PROVIDER_REGISTRARS)) {
		ensureProviderOAuthRegistration(provider);
	}
}


function toNumberOrDefault(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	return fallback;
}

function toBooleanOrDefault(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	return fallback;
}

function toThinkingLevelMap(value: unknown): ProviderModelDefinition["thinkingLevelMap"] {
	if (!isRecord(value)) {
		return undefined;
	}

	const normalized: NonNullable<ProviderModelDefinition["thinkingLevelMap"]> = {};
	let hasEntries = false;

	for (const key of THINKING_LEVEL_KEYS) {
		const mapped = value[key];
		if (typeof mapped === "string" || mapped === null) {
			normalized[key] = mapped;
			hasEntries = true;
		}
	}

	return hasEntries ? normalized : undefined;
}

function toInputList(value: unknown): ("text" | "image")[] {
	if (!Array.isArray(value)) {
		return ["text"];
	}

	const parsed = value
		.filter((item): item is "text" | "image" => item === "text" || item === "image")
		.slice(0, 2);

	return parsed.length > 0 ? parsed : ["text"];
}

function toCost(value: unknown): ProviderModelDefinition["cost"] {
	if (!isRecord(value)) {
		return {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		};
	}

	return {
		input: typeof value.input === "number" ? value.input : 0,
		output: typeof value.output === "number" ? value.output : 0,
		cacheRead: typeof value.cacheRead === "number" ? value.cacheRead : 0,
		cacheWrite: typeof value.cacheWrite === "number" ? value.cacheWrite : 0,
	};
}

function normalizeModelRecord(model: unknown, providerApi: Api): ProviderModelDefinition | null {
	if (!isRecord(model) || typeof model.id !== "string" || !model.id.trim()) {
		return null;
	}

	const modelId = model.id.trim();
	const compat = isRecord(model.compat) ? { ...model.compat } : undefined;
	const baseUrl = typeof model.baseUrl === "string" && model.baseUrl.trim() ? model.baseUrl.trim() : undefined;
	const headers = isRecord(model.headers)
		? Object.fromEntries(
				Object.entries(model.headers)
					.filter((entry): entry is [string, string] => typeof entry[1] === "string")
					.map(([key, value]) => [key, value]),
			)
		: undefined;
	const thinkingLevelMap = toThinkingLevelMap(model.thinkingLevelMap);

	return {
		id: modelId,
		name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : modelId,
		api: typeof model.api === "string" && model.api.trim() ? (model.api.trim() as Api) : providerApi,
		baseUrl,
		reasoning: toBooleanOrDefault(model.reasoning, false),
		thinkingLevelMap,
		input: toInputList(model.input),
		cost: toCost(model.cost),
		contextWindow: toNumberOrDefault(model.contextWindow, 128_000),
		maxTokens: toNumberOrDefault(model.maxTokens, 8_192),
		headers,
		compat,
	};
}

function mapBuiltInModel(model: Model<Api>): ProviderModelDefinition {
	const compat = isRecord((model as { compat?: unknown }).compat)
		? { ...((model as { compat?: Record<string, unknown> }).compat ?? {}) }
		: undefined;

	return {
		id: model.id,
		name: model.name,
		api: model.api,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
		input: [...model.input],
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
		},
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		headers: model.headers ? { ...model.headers } : undefined,
		compat,
	};
}

function getDefaultModelsPath(): string {
	return resolveAgentRuntimePath("models.json");
}

function createModelsFileCacheKey(fileStats: {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
}): string {
	return `${fileStats.mtimeMs}:${fileStats.ctimeMs}:${fileStats.size}`;
}

function normalizeModelsFileData(parsed: unknown): ModelsFileData {
	if (!isRecord(parsed) || !isRecord(parsed.providers)) {
		return EMPTY_MODELS_FILE;
	}

	const providers: Record<string, ModelsProviderEntry> = {};
	for (const [providerId, rawProvider] of Object.entries(parsed.providers)) {
		if (isRemovedLegacyGoogleProvider(providerId) || !isRecord(rawProvider)) {
			continue;
		}

		const api = rawProvider.api;
		const baseUrl = rawProvider.baseUrl;
		const rawModels = rawProvider.models;
		if (typeof api !== "string" || !api.trim()) {
			continue;
		}
		if (typeof baseUrl !== "string" || !baseUrl.trim()) {
			continue;
		}

		const models = Array.isArray(rawModels)
			? rawModels
					.map((model) => normalizeModelRecord(model, api as Api))
					.filter((model): model is ProviderModelDefinition => model !== null)
			: [];
		if (models.length === 0) {
			continue;
		}

		providers[providerId] = {
			api: api as Api,
			baseUrl: baseUrl.trim(),
			models,
		};
	}

	return { providers };
}

function isMissingFileError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof error.code === "string" &&
		error.code === "ENOENT"
	);
}

function isPiMonoApiKeyLoginProvider(
	providerId: string,
	oauthProviderIds: ReadonlySet<string>,
	builtInProviderIds: ReadonlySet<string>,
): boolean {
	if (BUILT_IN_API_KEY_LOGIN_PROVIDER_IDS.has(providerId)) {
		return true;
	}
	if (builtInProviderIds.has(providerId)) {
		return false;
	}
	return !oauthProviderIds.has(providerId);
}

function getApiKeyProviderDisplayName(providerId: string): string {
	return API_KEY_LOGIN_PROVIDER_DISPLAY_NAMES[providerId] ?? providerId;
}

export class ProviderRegistry {
	private modelsFileCache: ModelsFileCacheEntry | null = null;
	private modelsFileLoadPromise: Promise<ModelsFileData> | null = null;

	constructor(
		private readonly authWriter: AuthWriter = new AuthWriter(),
		private readonly modelsPath: string = getDefaultModelsPath(),
		private readonly legacyProviders: readonly string[] = LEGACY_SUPPORTED_PROVIDERS,
	) {}

	async discoverProviderIds(): Promise<SupportedProviderId[]> {
		const modelsFile = await this.readModelsFile();
		const seedProviders = [...this.legacyProviders, ...Object.keys(modelsFile.providers)];
		const authProviders = await this.authWriter.listProviderIds(seedProviders);

		const ordered: string[] = [];
		const seenProviders = new Set<string>();
		const pushUnique = (provider: string): void => {
			const normalized = provider.trim();
			if (!normalized || isRemovedLegacyGoogleProvider(normalized) || seenProviders.has(normalized)) {
				return;
			}
			seenProviders.add(normalized);
			ordered.push(normalized);
		};

		for (const provider of this.legacyProviders) {
			pushUnique(provider);
		}
		for (const provider of Object.keys(modelsFile.providers)) {
			pushUnique(provider);
		}
		for (const provider of authProviders) {
			pushUnique(provider);
		}

		return ordered;
	}

	getProviderCapabilities(provider: SupportedProviderId): ProviderCapabilities {
		if (isRemovedLegacyGoogleProvider(provider)) {
			return {
				provider,
				supportsApiKey: false,
				supportsOAuth: false,
				hasExternalAccountState: false,
				rotationProfile: "lightweight",
			};
		}

		ensureProviderOAuthRegistration(provider);
		const supportsOAuth = Boolean(
			getOAuthProvider(provider as Parameters<typeof getOAuthProvider>[0]),
		);
		const classification = resolveProviderRotationClassification(provider, {
			supportsOAuth,
		});
		return {
			provider,
			supportsApiKey: true,
			supportsOAuth,
			hasExternalAccountState: classification.hasExternalAccountState,
			rotationProfile: classification.rotationProfile,
		};
	}

	listAvailableOAuthProviders(): AvailableOAuthProvider[] {
		ensureFirstClassOAuthRegistrations();
		const seenProviders = new Set<SupportedProviderId>();
		const providers: AvailableOAuthProvider[] = [];
		for (const provider of getOAuthProviders()) {
			const providerId = provider.id.trim();
			if (!providerId || isRemovedLegacyGoogleProvider(providerId) || seenProviders.has(providerId)) {
				continue;
			}
			seenProviders.add(providerId);
			providers.push({
				provider: providerId,
				name: provider.name.trim() || providerId,
			});
		}
		return providers;
	}

	async listAvailableApiKeyProviders(): Promise<AvailableApiKeyProvider[]> {
		const modelsFile = await this.readModelsFile();
		const modelProviderIds = Object.keys(modelsFile.providers);
		const authProviderIds = await this.authWriter.listProviderIds([
			...this.legacyProviders,
			...modelProviderIds,
		]);
		const builtInProviderIds = new Set<string>(getProviders());
		const oauthProviderIds = new Set(
			this.listAvailableOAuthProviders().map((provider) => provider.provider),
		);
		const providers: AvailableApiKeyProvider[] = [];
		const seenProviders = new Set<SupportedProviderId>();
		const pushUnique = (provider: string): void => {
			const providerId = provider.trim();
			if (!providerId || isRemovedLegacyGoogleProvider(providerId) || seenProviders.has(providerId)) {
				return;
			}
			seenProviders.add(providerId);
			providers.push({
				provider: providerId,
				name: getApiKeyProviderDisplayName(providerId),
			});
		};

		for (const provider of BUILT_IN_API_KEY_LOGIN_PROVIDER_IDS) {
			pushUnique(provider);
		}
		for (const provider of modelProviderIds) {
			if (isPiMonoApiKeyLoginProvider(provider, oauthProviderIds, builtInProviderIds)) {
				pushUnique(provider);
			}
		}
		for (const provider of authProviderIds) {
			pushUnique(provider);
		}

		return providers;
	}

	/**
	 * Returns true when provider has model metadata from built-in registry or models.json.
	 */
	async hasModelMetadata(provider: SupportedProviderId): Promise<boolean> {
		if (isRemovedLegacyGoogleProvider(provider)) {
			return false;
		}

		const builtInModels = getModels(provider as Parameters<typeof getModels>[0]);
		if (builtInModels.length > 0) {
			return true;
		}

		const modelsFile = await this.readModelsFile();
		return Boolean(modelsFile.providers[provider]?.models.length);
	}

	/**
	 * Returns true for providers that only have OAuth credentials but no model metadata,
	 * such as integrations used by non-chat features.
	 */
	async isCredentialOnlyOAuthProvider(provider: SupportedProviderId): Promise<boolean> {
		if (isRemovedLegacyGoogleProvider(provider)) {
			return false;
		}

		const hasMetadata = await this.hasModelMetadata(provider);
		if (hasMetadata) {
			return false;
		}

		ensureProviderOAuthRegistration(provider);
		const supportsOAuth = Boolean(
			getOAuthProvider(provider as Parameters<typeof getOAuthProvider>[0]),
		);
		if (supportsOAuth) {
			return true;
		}

		const credentialIds = await this.authWriter.listProviderCredentialIds(provider);
		for (const credentialId of credentialIds) {
			const credential = await this.authWriter.getCredential(credentialId);
			if (credential?.type === "oauth") {
				return true;
			}
		}

		return false;
	}

	async resolveProviderRegistrationMetadata(
		provider: SupportedProviderId,
	): Promise<ProviderRegistrationMetadata | null> {
		if (isRemovedLegacyGoogleProvider(provider)) {
			return null;
		}

		const builtInModels = getModels(provider as Parameters<typeof getModels>[0]);
		if (builtInModels.length > 0) {
			const firstModel = builtInModels[0];
			if (!firstModel.baseUrl) {
				return null;
			}

			const apis = [...new Set(builtInModels.map((m) => m.api))];
			return {
				provider,
				api: firstModel.api,
				apis,
				baseUrl: firstModel.baseUrl,
				models: builtInModels.map(mapBuiltInModel),
			};
		}

		const modelsFile = await this.readModelsFile();
		const fromFile = modelsFile.providers[provider];
		if (!fromFile || fromFile.models.length === 0) {
			return null;
		}

		const modelApis = fromFile.models
			.map((model) => model.api)
			.filter((api): api is Api => typeof api === "string");
		const apis: Api[] = modelApis.length > 0 ? [...new Set(modelApis)] : [fromFile.api];

		return {
			provider,
			api: fromFile.api,
			apis,
			baseUrl: fromFile.baseUrl,
			models: [...fromFile.models],
		};
	}

	private async readModelsFile(): Promise<ModelsFileData> {
		if (this.modelsFileLoadPromise) {
			return this.modelsFileLoadPromise;
		}

		const loadPromise = this.loadModelsFile();
		const wrappedPromise = loadPromise.finally(() => {
			if (this.modelsFileLoadPromise === wrappedPromise) {
				this.modelsFileLoadPromise = null;
			}
		});
		this.modelsFileLoadPromise = wrappedPromise;
		return wrappedPromise;
	}

	private async loadModelsFile(): Promise<ModelsFileData> {
		let fileStats: Awaited<ReturnType<typeof stat>>;
		try {
			fileStats = await stat(this.modelsPath);
		} catch (error) {
			if (!isMissingFileError(error)) {
				this.modelsFileCache = null;
			}
			return EMPTY_MODELS_FILE;
		}

		const cacheKey = createModelsFileCacheKey(fileStats);
		if (this.modelsFileCache?.cacheKey === cacheKey) {
			return this.modelsFileCache.data;
		}

		let parsed: unknown;
		try {
			const content = await readFile(this.modelsPath, "utf-8");
			parsed = JSON.parse(content);
		} catch {
			const empty = EMPTY_MODELS_FILE;
			this.modelsFileCache = { cacheKey, data: empty };
			return empty;
		}

		const data = normalizeModelsFileData(parsed);
		this.modelsFileCache = { cacheKey, data };
		return data;
	}
}
