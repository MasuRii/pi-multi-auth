import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

interface ProviderBadgeOptions {
	isHidden: boolean;
	isManual: boolean;
	visibleCount: number;
	totalCount: number;
	maxWidth: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function toSafeWidth(width: number): number {
	if (!Number.isFinite(width)) {
		return 1;
	}
	return Math.max(1, Math.floor(width));
}

function sliceToWidth(value: string, maxWidth: number): string {
	const safeWidth = toSafeWidth(maxWidth);
	let result = "";
	let consumed = 0;

	for (const char of value) {
		const charWidth = Math.max(0, visibleWidth(char));
		if (result && consumed + charWidth > safeWidth) {
			break;
		}
		if (!result && charWidth > safeWidth) {
			continue;
		}
		result += char;
		consumed += charWidth;
	}

	return result;
}

function parseEmail(value: string): { local: string; domain: string } | null {
	const trimmed = value.trim();
	if (!trimmed || /\s/.test(trimmed)) {
		return null;
	}

	const atIndex = trimmed.indexOf("@");
	if (atIndex <= 0 || atIndex >= trimmed.length - 1) {
		return null;
	}

	if (trimmed.indexOf("@", atIndex + 1) >= 0) {
		return null;
	}

	const local = trimmed.slice(0, atIndex);
	const domain = trimmed.slice(atIndex + 1);
	if (!local || !domain || !domain.includes(".")) {
		return null;
	}

	return { local, domain };
}

export function normalizeInlineText(value: string): string {
	return value.replace(/[\r\n]+/g, " ");
}

function truncateEmailAddress(email: string, maxWidth: number): string {
	const safeWidth = toSafeWidth(maxWidth);
	if (visibleWidth(email) <= safeWidth) {
		return email;
	}
	if (safeWidth <= 5) {
		return truncateToWidth(email, safeWidth, "…", true);
	}

	const parsed = parseEmail(email);
	if (!parsed) {
		return truncateToWidth(email, safeWidth, "…", true);
	}

	const { local, domain } = parsed;
	const domainWidth = visibleWidth(domain);
	const middleLocalWidth = safeWidth - domainWidth - 2;
	if (middleLocalWidth >= 1) {
		const localPrefix = sliceToWidth(local, middleLocalWidth);
		const candidate = `${localPrefix}…@${domain}`;
		if (visibleWidth(candidate) <= safeWidth) {
			return candidate;
		}
	}

	const localWidth = visibleWidth(local);
	const domainTailWidth = safeWidth - localWidth - 2;
	if (domainTailWidth >= 1) {
		const domainPrefix = sliceToWidth(domain, domainTailWidth);
		const candidate = `${local}@${domainPrefix}…`;
		if (visibleWidth(candidate) <= safeWidth) {
			return candidate;
		}
	}

	const fallbackLocalWidth = clamp(safeWidth - 4, 1, Math.max(1, localWidth));
	const fallback = `${sliceToWidth(local, fallbackLocalWidth)}…@${sliceToWidth(domain, 1)}`;
	if (visibleWidth(fallback) <= safeWidth) {
		return fallback;
	}

	return truncateToWidth(email, safeWidth, "…", true);
}

export function truncateAccountIdentifier(value: string, maxWidth: number): string {
	const safeWidth = toSafeWidth(maxWidth);
	const normalized = normalizeInlineText(value);
	if (!normalized) {
		return "";
	}
	if (visibleWidth(normalized) <= safeWidth) {
		return normalized;
	}

	const parsed = parseEmail(normalized);
	if (!parsed) {
		return truncateToWidth(normalized, safeWidth, "…", true);
	}

	return truncateEmailAddress(`${parsed.local}@${parsed.domain}`, safeWidth);
}

export function formatProviderBadge(options: ProviderBadgeOptions): string {
	const safeWidth = Math.max(0, Math.floor(options.maxWidth));
	if (safeWidth <= 0) {
		return "";
	}

	const shown = Math.max(0, Math.floor(options.visibleCount));
	const total = Math.max(0, Math.floor(options.totalCount));
	const countLabel = `${shown}/${total}`;
	const wideTokens = [
		options.isHidden ? "Hidden" : "",
		options.isManual ? "Manual" : "",
		countLabel,
	].filter(Boolean);
	const compactTokens = [
		options.isHidden ? "Hid" : "",
		options.isManual ? "Man" : "",
		countLabel,
	].filter(Boolean);
	const narrowTokens = [
		options.isHidden ? "H" : "",
		options.isManual ? "M" : "",
		countLabel,
	].filter(Boolean);

	const variants = [
		`[${wideTokens.join(" • ")}]`,
		`[${compactTokens.join(" ")}]`,
		`[${narrowTokens.join(" ")}]`,
		`[${countLabel}]`,
	];

	for (const variant of variants) {
		if (visibleWidth(variant) <= safeWidth) {
			return variant;
		}
	}

	return truncateToWidth(variants[variants.length - 1] ?? "[]", toSafeWidth(safeWidth), "…", true);
}
