import { visibleWidth } from "@mariozechner/pi-tui";

const FOOTER_SEPARATOR = "  ";

interface BodyRowBudgetOptions {
	defaultRows: number;
	terminalRows: number | null;
	reservedRows: number;
	minimumRows?: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function toSafePositiveInteger(value: number, fallback: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(1, Math.floor(value));
}

function splitLongToken(token: string, maxWidth: number): string[] {
	const safeWidth = Math.max(1, maxWidth);
	const parts: string[] = [];
	let current = "";
	let currentWidth = 0;

	for (const char of token) {
		const charWidth = Math.max(0, visibleWidth(char));
		if (current && currentWidth + charWidth > safeWidth) {
			parts.push(current);
			current = char;
			currentWidth = charWidth;
			continue;
		}
		current += char;
		currentWidth += charWidth;
	}

	if (current) {
		parts.push(current);
	}

	return parts.length > 0 ? parts : [""];
}

export function wrapTextToWidth(text: string, maxWidth: number): string[] {
	const safeWidth = Math.max(1, Math.floor(maxWidth));
	const trimmed = text.trim();
	if (!trimmed) {
		return [];
	}

	const words = trimmed.split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return [];
	}

	const lines: string[] = [];
	let currentLine = "";
	let currentWidth = 0;

	for (const word of words) {
		const wordWidth = Math.max(0, visibleWidth(word));
		if (wordWidth > safeWidth) {
			if (currentLine) {
				lines.push(currentLine);
				currentLine = "";
				currentWidth = 0;
			}
			lines.push(...splitLongToken(word, safeWidth));
			continue;
		}

		if (!currentLine) {
			currentLine = word;
			currentWidth = wordWidth;
			continue;
		}

		if (currentWidth + 1 + wordWidth <= safeWidth) {
			currentLine += ` ${word}`;
			currentWidth += 1 + wordWidth;
			continue;
		}

		lines.push(currentLine);
		currentLine = word;
		currentWidth = wordWidth;
	}

	if (currentLine) {
		lines.push(currentLine);
	}

	return lines;
}

export function renderWrappedFooterActions(actions: readonly string[], maxWidth: number): string[] {
	const safeWidth = Math.max(1, Math.floor(maxWidth));
	const normalizedActions = actions.map((action) => action.trim()).filter(Boolean);
	if (normalizedActions.length === 0) {
		return [];
	}

	const lines: string[] = [];
	let currentLine = "";
	let currentWidth = 0;
	const separatorWidth = visibleWidth(FOOTER_SEPARATOR);

	for (const action of normalizedActions) {
		const wrappedActionParts = wrapTextToWidth(action, safeWidth);
		for (const part of wrappedActionParts) {
			const partWidth = Math.max(0, visibleWidth(part));
			if (!currentLine) {
				currentLine = part;
				currentWidth = partWidth;
				continue;
			}

			if (currentWidth + separatorWidth + partWidth <= safeWidth) {
				currentLine += `${FOOTER_SEPARATOR}${part}`;
				currentWidth += separatorWidth + partWidth;
				continue;
			}

			lines.push(currentLine);
			currentLine = part;
			currentWidth = partWidth;
		}
	}

	if (currentLine) {
		lines.push(currentLine);
	}

	return lines;
}

export function resolveTerminalRows(): number | null {
	if (typeof process.stdout.rows === "number" && Number.isFinite(process.stdout.rows)) {
		return toSafePositiveInteger(process.stdout.rows, 1);
	}

	const fromEnv = Number.parseInt(process.env.LINES ?? "", 10);
	if (Number.isFinite(fromEnv) && fromEnv > 0) {
		return toSafePositiveInteger(fromEnv, 1);
	}

	return null;
}

export function resolveBodyRowBudget(options: BodyRowBudgetOptions): number {
	const defaultRows = Math.max(1, Math.floor(options.defaultRows));
	const minimumRows = clamp(Math.floor(options.minimumRows ?? 4), 1, defaultRows);

	if (typeof options.terminalRows !== "number" || !Number.isFinite(options.terminalRows)) {
		return defaultRows;
	}

	const terminalRows = toSafePositiveInteger(options.terminalRows, defaultRows);
	const reservedRows = Math.max(0, Math.floor(options.reservedRows));
	const availableRows = terminalRows - reservedRows;
	return clamp(availableRows, minimumRows, defaultRows);
}

export function clampRenderedRows(lines: string[], maxRows: number): string[] {
	const safeMaxRows = Math.max(0, Math.floor(maxRows));
	if (safeMaxRows === 0) {
		return [];
	}
	if (lines.length <= safeMaxRows) {
		return lines;
	}
	if (safeMaxRows === 1) {
		return ["…"];
	}
	return [...lines.slice(0, safeMaxRows - 1), "…"];
}
