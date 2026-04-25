import { LoginDialogComponent, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getErrorMessage } from "./auth-error-utils.js";
import type { AccountManager } from "./account-manager.js";
import type { OAuthLoginCallbacks } from "./oauth-compat.js";
import type { SupportedProviderId } from "./types.js";

export const MANUAL_CODE_INPUT_PROMPT = "Paste authorization code or callback URL:";

const OAUTH_LOGIN_OVERLAY_OPTIONS = {
	anchor: "center" as const,
	width: "88%" as const,
	maxHeight: "88%" as const,
	margin: 1,
};

export interface OAuthDialogDriver {
	readonly signal: AbortSignal;
	showAuth(url: string, instructions?: string): void;
	showPrompt(message: string, placeholder?: string): Promise<string>;
	showManualInput(prompt: string): Promise<string>;
	showWaiting(message: string): void;
	showProgress(message: string): void;
}

interface StoredOAuthLoginResult {
	credentialId: string;
	isBackupCredential: boolean;
	credentialIds: string[];
}

type OAuthDialogResult =
	| {
		status: "success";
		result: {
			message: string;
			credentialId: string;
		};
	}
	| {
		status: "cancelled";
		message: string;
	}
	| {
		status: "error";
		message: string;
	};

function requireOAuthInput(value: string, message: string): string {
	if (value.trim()) {
		return value;
	}
	throw new Error(message);
}

export class OAuthDialogCallbackBridge {
	private hasShownWaitingState = false;

	constructor(private readonly dialog: OAuthDialogDriver) {}

	createCallbacks(): OAuthLoginCallbacks {
		return {
			signal: this.dialog.signal,
			onAuth: ({ url, instructions }) => {
				this.hasShownWaitingState = false;
				this.dialog.showAuth(url, instructions);
			},
			onPrompt: async ({ message, placeholder, allowEmpty }) => {
				this.hasShownWaitingState = false;
				const value = await this.dialog.showPrompt(message, placeholder);
				if (allowEmpty) {
					return value;
				}
				return requireOAuthInput(value, "OAuth input is required to continue login.");
			},
			onProgress: (message) => {
				const normalizedMessage = message.trim();
				if (!normalizedMessage) {
					return;
				}
				if (!this.hasShownWaitingState) {
					this.dialog.showWaiting(normalizedMessage);
					this.hasShownWaitingState = true;
					return;
				}
				this.dialog.showProgress(normalizedMessage);
			},
			onManualCodeInput: async () => {
				this.hasShownWaitingState = false;
				const value = await this.dialog.showManualInput(MANUAL_CODE_INPUT_PROMPT);
				return requireOAuthInput(
					value,
					"Authorization code or callback URL is required to continue login.",
				);
			},
		};
	}
}

export function formatOAuthLoginSuccessMessage(
	provider: SupportedProviderId,
	result: StoredOAuthLoginResult,
): string {
	const slotMessage = result.isBackupCredential
		? `Stored as backup credential ${result.credentialId}.`
		: `Stored as primary credential ${result.credentialId}.`;
	return `OAuth login successful for ${provider}. ${slotMessage} Total credentials: ${result.credentialIds.length}`;
}

function toCancelledResult(message: string): OAuthDialogResult {
	return {
		status: "cancelled",
		message: message.trim() || "Login cancelled",
	};
}

function isCancellationError(error: unknown, signal: AbortSignal): boolean {
	if (signal.aborted) {
		return true;
	}
	const message = getErrorMessage(error).toLowerCase();
	return message.includes("cancelled") || message.includes("aborted");
}

export async function runOAuthLoginDialog(
	ctx: ExtensionCommandContext,
	accountManager: AccountManager,
	provider: SupportedProviderId,
): Promise<{ message: string; credentialId: string }> {
	const dialogResult = await ctx.ui.custom<OAuthDialogResult>(
		async (tui, _theme, _keybindings, done) => {
			let settled = false;
			const settle = (result: OAuthDialogResult): void => {
				if (settled) {
					return;
				}
				settled = true;
				done(result);
			};

			const dialog = new LoginDialogComponent(tui, provider, (success, message) => {
				if (!success) {
					settle(toCancelledResult(message ?? "Login cancelled"));
				}
			});
			const callbackBridge = new OAuthDialogCallbackBridge(dialog);

			void accountManager
				.loginProvider(provider, callbackBridge.createCallbacks())
				.then((result) => {
					settle({
						status: "success",
						result: {
							message: formatOAuthLoginSuccessMessage(provider, result),
							credentialId: result.credentialId,
						},
					});
				})
				.catch((error: unknown) => {
					const message = getErrorMessage(error);
					if (isCancellationError(error, dialog.signal)) {
						settle(toCancelledResult(message));
						return;
					}
					settle({
						status: "error",
						message,
					});
				});

			return dialog;
		},
		{
			overlay: true,
			overlayOptions: OAUTH_LOGIN_OVERLAY_OPTIONS,
		},
	);

	if (dialogResult.status === "success") {
		return dialogResult.result;
	}

	throw new Error(dialogResult.message);
}
