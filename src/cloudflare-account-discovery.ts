import { getErrorMessage } from "./auth-error-utils.js";
import { buildCloudflareWorkersAiBaseUrl } from "./credential-request-overrides.js";

const CLOUDFLARE_ACCOUNTS_URL = "https://api.cloudflare.com/client/v4/accounts";

interface CloudflareApiError {
	code?: number;
	message?: string;
}

interface CloudflareAccountRecord {
	id?: string;
	name?: string;
}

interface CloudflareAccountsResponse {
	success?: boolean;
	result?: CloudflareAccountRecord[];
	errors?: CloudflareApiError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCloudflareAccountsResponse(value: unknown): CloudflareAccountsResponse {
	if (!isRecord(value)) {
		throw new Error("Cloudflare accounts response was not a JSON object.");
	}

	const result = Array.isArray(value.result)
		? value.result.filter(isRecord).map((account) => ({
				id: typeof account.id === "string" ? account.id : undefined,
				name: typeof account.name === "string" ? account.name : undefined,
			}))
		: undefined;
	const errors = Array.isArray(value.errors)
		? value.errors.filter(isRecord).map((error) => ({
				code: typeof error.code === "number" ? error.code : undefined,
				message: typeof error.message === "string" ? error.message : undefined,
			}))
		: undefined;

	return {
		success: typeof value.success === "boolean" ? value.success : undefined,
		result,
		errors,
	};
}

function formatCloudflareErrors(errors: CloudflareApiError[] | undefined): string {
	if (!errors || errors.length === 0) {
		return "Cloudflare did not return an error message.";
	}
	return errors
		.map((error) => {
			const code = typeof error.code === "number" ? `${error.code}: ` : "";
			return `${code}${error.message ?? "Unknown Cloudflare error"}`;
		})
		.join("; ");
}

async function readCloudflareJsonResponse(response: Response): Promise<CloudflareAccountsResponse> {
	let parsed: unknown;
	try {
		parsed = await response.json();
	} catch (error: unknown) {
		throw new Error(
			`Cloudflare accounts response was not valid JSON: ${getErrorMessage(error)}`,
		);
	}
	return parseCloudflareAccountsResponse(parsed);
}

export async function discoverCloudflareWorkersAiBaseUrl(
	apiToken: string,
	options?: { signal?: AbortSignal },
): Promise<string> {
	const response = await fetch(CLOUDFLARE_ACCOUNTS_URL, {
		method: "GET",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiToken}`,
		},
		signal: options?.signal,
	});
	const payload = await readCloudflareJsonResponse(response);

	if (!response.ok || payload.success !== true) {
		throw new Error(
			`Cloudflare account discovery failed with HTTP ${response.status}: ${formatCloudflareErrors(payload.errors)}`,
		);
	}

	const accounts = (payload.result ?? []).filter(
		(account): account is Required<Pick<CloudflareAccountRecord, "id">> & CloudflareAccountRecord =>
			typeof account.id === "string" && account.id.trim().length > 0,
	);

	if (accounts.length === 0) {
		throw new Error(
			"Cloudflare account discovery did not return any accounts. Add request.baseUrl manually or grant the token account read/list access.",
		);
	}

	if (accounts.length > 1) {
		const names = accounts
			.map((account) => account.name ?? account.id)
			.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
			.join(", ");
		throw new Error(
			`Cloudflare account discovery returned multiple accounts (${names}). Add request.baseUrl manually for this credential so multi-auth uses the intended account.`,
		);
	}

	return buildCloudflareWorkersAiBaseUrl(accounts[0].id.trim());
}
