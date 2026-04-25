import { getErrorMessage } from "./auth-error-utils.js";
import {
	DEFAULT_OAUTH_CONFIG,
	isOAuthRefreshFailureError,
	type OAuthRefreshConfig,
	type RefreshResult,
	type ScheduledRefresh,
	type TokenExpiration,
} from "./types-oauth.js";

function toBase64(value: string): string {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padding = normalized.length % 4;
	return padding === 0 ? normalized : `${normalized}${"=".repeat(4 - padding)}`;
}

function cloneScheduledRefresh(entry: ScheduledRefresh): ScheduledRefresh {
	return { ...entry };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function normalizeExcludedProviders(value: string[] | undefined): string[] {
	if (!Array.isArray(value)) {
		return [...DEFAULT_OAUTH_CONFIG.excludedProviders];
	}

	return [...new Set(value.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function normalizeOAuthRefreshConfig(config: Partial<OAuthRefreshConfig>): OAuthRefreshConfig {
	return {
		enabled: config.enabled ?? DEFAULT_OAUTH_CONFIG.enabled,
		safetyWindowMs: normalizePositiveInteger(
			config.safetyWindowMs,
			DEFAULT_OAUTH_CONFIG.safetyWindowMs,
		),
		minRefreshWindowMs: normalizePositiveInteger(
			config.minRefreshWindowMs,
			DEFAULT_OAUTH_CONFIG.minRefreshWindowMs,
		),
		checkIntervalMs: normalizePositiveInteger(
			config.checkIntervalMs,
			DEFAULT_OAUTH_CONFIG.checkIntervalMs,
		),
		maxConcurrentRefreshes: normalizePositiveInteger(
			config.maxConcurrentRefreshes,
			DEFAULT_OAUTH_CONFIG.maxConcurrentRefreshes,
		),
		requestTimeoutMs: normalizePositiveInteger(
			config.requestTimeoutMs,
			DEFAULT_OAUTH_CONFIG.requestTimeoutMs,
		),
		excludedProviders: normalizeExcludedProviders(config.excludedProviders),
	};
}

export function extractJwtExpiration(token: string): number | null {
	if (!token) {
		return null;
	}

	try {
		const parts = token.split(".");
		if (parts.length !== 3 || !parts[1]) {
			return null;
		}
		const payload = JSON.parse(Buffer.from(toBase64(parts[1]), "base64").toString("utf-8")) as {
			exp?: unknown;
		};
		return typeof payload.exp === "number" && Number.isFinite(payload.exp)
			? payload.exp * 1000
			: null;
	} catch {
		return null;
	}
}

export function determineTokenExpiration(
	token: string,
	expiresAtField?: number,
	expiresInField?: number,
	defaultMs: number = 60 * 60_000,
): Pick<TokenExpiration, "expiresAt" | "source"> {
	const jwtExpiration = extractJwtExpiration(token);
	if (jwtExpiration !== null) {
		return { expiresAt: jwtExpiration, source: "jwt_exp" };
	}
	if (typeof expiresAtField === "number" && Number.isFinite(expiresAtField)) {
		return { expiresAt: expiresAtField, source: "expires_at" };
	}
	if (typeof expiresInField === "number" && Number.isFinite(expiresInField)) {
		return { expiresAt: Date.now() + expiresInField * 1000, source: "expires_in" };
	}
	return { expiresAt: Date.now() + defaultMs, source: "default" };
}

export function needsRefresh(expiresAt: number, safetyWindowMs: number = 60_000): boolean {
	return expiresAt - Date.now() < safetyWindowMs;
}

export function timeUntilRefresh(expiresAt: number, safetyWindowMs: number = 60_000): number {
	return Math.max(0, expiresAt - safetyWindowMs - Date.now());
}

export type OAuthRefreshHandler = (
	credentialId: string,
	providerId: string,
) => Promise<number | undefined>;

export class OAuthRefreshScheduler {
	private config: OAuthRefreshConfig;
	private readonly scheduled = new Map<string, ScheduledRefresh>();
	private readonly pendingRefreshes = new Set<string>();
	private wakeTimer: ReturnType<typeof setTimeout> | null = null;
	private wakeTimerScheduledAt: number | null = null;
	private started = false;

	constructor(
		private readonly refreshHandler: OAuthRefreshHandler,
		config: Partial<OAuthRefreshConfig> = {},
	) {
		this.config = normalizeOAuthRefreshConfig({
			...DEFAULT_OAUTH_CONFIG,
			...config,
		});
	}

	updateConfig(config: Partial<OAuthRefreshConfig>): void {
		this.config = normalizeOAuthRefreshConfig({
			...DEFAULT_OAUTH_CONFIG,
			...config,
		});
		if (this.config.enabled && !this.started) {
			this.start();
		} else if (!this.config.enabled && this.started) {
			this.stop();
		}
	}

	start(): void {
		if (!this.config.enabled || this.started) {
			return;
		}
		this.started = true;
		this.scheduleNextWake();
	}

	stop(): void {
		if (this.wakeTimer) {
			clearTimeout(this.wakeTimer);
			this.wakeTimer = null;
		}
		this.wakeTimerScheduledAt = null;
		this.pendingRefreshes.clear();
		this.started = false;
	}

	scheduleRefresh(credentialId: string, providerId: string, expiresAt: number): void {
		if (!this.config.enabled) {
			return;
		}

		const normalizedCredentialId = credentialId.trim();
		const normalizedProviderId = providerId.trim();
		if (!normalizedCredentialId || !normalizedProviderId || !Number.isFinite(expiresAt)) {
			return;
		}

		const refreshAt = expiresAt - this.config.safetyWindowMs;
		const nextScheduledAt = Math.max(Date.now(), refreshAt);
		this.scheduled.set(normalizedCredentialId, {
			credentialId: normalizedCredentialId,
			providerId: normalizedProviderId,
			scheduledAt: nextScheduledAt,
			isPending: false,
			attempts: 0,
		});
		this.pendingRefreshes.delete(normalizedCredentialId);

		if (nextScheduledAt - Date.now() <= this.config.minRefreshWindowMs) {
			void this.processDueRefreshes();
			return;
		}

		this.scheduleNextWake();
	}

	cancelRefresh(credentialId: string): void {
		const existing = this.scheduled.get(credentialId);
		this.pendingRefreshes.delete(credentialId);
		this.scheduled.delete(credentialId);
		if (existing) {
			this.scheduleNextWake();
		}
	}

	getPendingRefreshes(): Map<string, ScheduledRefresh> {
		return new Map(
			[...this.scheduled.entries()].map(([credentialId, entry]) => [
				credentialId,
				cloneScheduledRefresh(entry),
			]),
		);
	}

	private scheduleNextWake(): void {
		if (!this.started || !this.config.enabled) {
			return;
		}

		const nextDueAt = this.findNextScheduledAt();
		if (nextDueAt === null) {
			if (this.wakeTimer) {
				clearTimeout(this.wakeTimer);
				this.wakeTimer = null;
			}
			this.wakeTimerScheduledAt = null;
			return;
		}

		if (this.wakeTimer && this.wakeTimerScheduledAt === nextDueAt) {
			return;
		}

		if (this.wakeTimer) {
			clearTimeout(this.wakeTimer);
		}

		const delayMs = Math.max(0, nextDueAt - Date.now());
		this.wakeTimerScheduledAt = nextDueAt;
		this.wakeTimer = setTimeout(() => {
			this.wakeTimer = null;
			this.wakeTimerScheduledAt = null;
			void this.processDueRefreshes();
		}, delayMs);
		this.wakeTimer.unref?.();
	}

	private findNextScheduledAt(): number | null {
		let nextDueAt: number | null = null;
		for (const entry of this.scheduled.values()) {
			if (entry.isPending) {
				continue;
			}
			if (nextDueAt === null || entry.scheduledAt < nextDueAt) {
				nextDueAt = entry.scheduledAt;
			}
		}
		return nextDueAt;
	}

	private async processDueRefreshes(): Promise<void> {
		if (!this.config.enabled || !this.started) {
			return;
		}

		const now = Date.now();
		const availableSlots = Math.max(0, this.config.maxConcurrentRefreshes - this.pendingRefreshes.size);
		if (availableSlots === 0) {
			this.scheduleNextWake();
			return;
		}

		const dueEntries: ScheduledRefresh[] = [];
		for (const entry of this.scheduled.values()) {
			if (entry.isPending || entry.scheduledAt > now) {
				continue;
			}
			dueEntries.push(entry);
		}

		if (dueEntries.length === 0) {
			this.scheduleNextWake();
			return;
		}

		const entriesToRefresh = dueEntries.slice(0, availableSlots);
		const deferredEntries = dueEntries.slice(availableSlots);

		for (const entry of deferredEntries) {
			this.scheduleRetry(entry, Date.now() + this.config.minRefreshWindowMs);
		}

		await Promise.allSettled(
			entriesToRefresh.map((entry) => this.triggerRefresh(entry.credentialId, entry.providerId)),
		);
		this.scheduleNextWake();
	}

	private async triggerRefresh(credentialId: string, providerId: string): Promise<RefreshResult> {
		const existing = this.scheduled.get(credentialId);
		if (!existing) {
			return {
				credentialId,
				success: false,
				error: "Refresh was not scheduled.",
				attemptedAt: Date.now(),
			};
		}
		if (this.pendingRefreshes.has(credentialId)) {
			return {
				credentialId,
				success: false,
				error: "Refresh is already pending.",
				attemptedAt: Date.now(),
			};
		}
		if (
			this.pendingRefreshes.size >= this.config.maxConcurrentRefreshes &&
			!this.pendingRefreshes.has(credentialId)
		) {
			this.scheduleRetry(existing, Date.now() + this.config.minRefreshWindowMs);
			return {
				credentialId,
				success: false,
				error: "Refresh concurrency limit reached.",
				attemptedAt: Date.now(),
			};
		}

		this.pendingRefreshes.add(credentialId);
		existing.isPending = true;
		existing.attempts += 1;

		try {
			const newExpiresAt = await this.refreshHandler(credentialId, providerId);
			this.pendingRefreshes.delete(credentialId);
			existing.isPending = false;
			if (typeof newExpiresAt === "number" && Number.isFinite(newExpiresAt)) {
				this.scheduleRefresh(credentialId, providerId, newExpiresAt);
				return {
					credentialId,
					success: true,
					newExpiresAt,
					attemptedAt: Date.now(),
				};
			}
			this.scheduleRetry(existing, Date.now() + this.config.minRefreshWindowMs);
			return {
				credentialId,
				success: false,
				error: "Refresh completed without a valid expiration timestamp.",
				attemptedAt: Date.now(),
			};
		} catch (error) {
			this.pendingRefreshes.delete(credentialId);
			existing.isPending = false;
			if (isOAuthRefreshFailureError(error) && error.details.permanent) {
				this.scheduled.delete(credentialId);
				return {
					credentialId,
					success: false,
					error: error.message,
					attemptedAt: Date.now(),
				};
			}
			this.scheduleRetry(existing, Date.now() + this.config.minRefreshWindowMs);
			return {
				credentialId,
				success: false,
				error: getErrorMessage(error),
				attemptedAt: Date.now(),
			};
		}
	}

	private scheduleRetry(entry: ScheduledRefresh, scheduledAt: number): void {
		const nextScheduledAt = Math.max(Date.now() + 1, scheduledAt);
		const nextEntry: ScheduledRefresh = {
			...entry,
			scheduledAt: nextScheduledAt,
			isPending: false,
		};
		this.scheduled.set(entry.credentialId, nextEntry);
		this.scheduleNextWake();
	}
}
