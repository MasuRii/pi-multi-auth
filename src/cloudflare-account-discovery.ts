import { getErrorMessage, isRecord } from "./auth-error-utils.js";
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

function resolveCloudflareDiscoveryHint(
	status: number,
	errors: CloudflareApiError[] | undefined,
): string | null {
	const messages = (errors ?? [])
		.map((error) => error.message ?? "")
		.join(" ");
	const codes = new Set(
		(errors ?? [])
			.map((error) => error.code)
			.filter((code): code is number => typeof code === "number"),
	);

	if (codes.has(1211) || /verify\s+your\s+email/i.test(messages)) {
		return "Verify the Cloudflare account email in the dashboard, then create or retry the API token.";
	}
	if (status === 401) {
		return "Check that the pasted value is a Cloudflare API token and not a redacted token preview.";
	}
	if (status === 403) {
		return "Grant account read/list access for automatic discovery, or paste the account ID, dashboard token URL, or full Workers AI base URL alongside the token.";
	}
	return null;
}

function formatCloudflareDiscoveryFailure(
	status: number,
	errors: CloudflareApiError[] | undefined,
): string {
	const detail = formatCloudflareErrors(errors);
	const hint = resolveCloudflareDiscoveryHint(status, errors);
	return hint ? `${detail} ${hint}` : detail;
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
			`Cloudflare account discovery failed with HTTP ${response.status}: ${formatCloudflareDiscoveryFailure(response.status, payload.errors)}`,
		);
	}

	const accounts = (payload.result ?? []).filter(
		(account): account is Required<Pick<CloudflareAccountRecord, "id">> & CloudflareAccountRecord =>
			typeof account.id === "string" && account.id.trim().length > 0,
	);

	if (accounts.length === 0) {
		throw new Error(
			"Cloudflare account discovery did not return any accounts. Paste the account ID, dashboard token URL, or full Workers AI base URL alongside the token, or grant the token account read/list access.",
		);
	}

	if (accounts.length > 1) {
		const names = accounts
			.map((account) => account.name ?? account.id)
			.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
			.join(", ");
		throw new Error(
			`Cloudflare account discovery returned multiple accounts (${names}). Paste the intended account ID, dashboard token URL, or full Workers AI base URL alongside this token so multi-auth uses the intended account.`,
		);
	}

	return buildCloudflareWorkersAiBaseUrl(accounts[0].id.trim());
}
