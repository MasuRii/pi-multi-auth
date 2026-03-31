export interface BorderGlyphSet {
	horizontal: string;
	vertical: string;
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	cross: string;
	teeUp: string;
}

const UNICODE_BORDER_GLYPHS: BorderGlyphSet = {
	horizontal: "─",
	vertical: "│",
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	cross: "┼",
	teeUp: "┴",
};

const ASCII_BORDER_GLYPHS: BorderGlyphSet = {
	horizontal: "-",
	vertical: "|",
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	cross: "+",
	teeUp: "+",
};

function isTruthyFlag(value: string | undefined): boolean {
	if (!value) {
		return false;
	}

	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		default:
			return false;
	}
}

/**
 * Determines whether border glyphs should fall back to ASCII.
 */
export function shouldUseAsciiBorders(): boolean {
	if (
		isTruthyFlag(process.env.PI_TUI_ASCII_BORDERS) ||
		isTruthyFlag(process.env.PI_MULTI_AUTH_ASCII_BORDERS)
	) {
		return true;
	}

	const term = process.env.TERM?.trim().toLowerCase();
	if (term === "dumb") {
		return true;
	}

	const locale = (process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "")
		.trim()
		.toLowerCase();
	if (locale.length > 0 && !locale.includes("utf-8") && !locale.includes("utf8")) {
		return true;
	}

	return false;
}

/**
 * Returns border glyphs for either Unicode or ASCII-safe rendering.
 */
export function resolveBorderGlyphs(): BorderGlyphSet {
	return shouldUseAsciiBorders() ? ASCII_BORDER_GLYPHS : UNICODE_BORDER_GLYPHS;
}
