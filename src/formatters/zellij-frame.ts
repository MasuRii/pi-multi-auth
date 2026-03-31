import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { resolveBorderGlyphs, type BorderGlyphSet } from "./charset.js";
import { normalizeInlineText } from "./multi-auth-display.js";

interface FrameThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface ZellijFrameOptions {
	titleLeft: string;
	titleRight?: string;
	helpText?: string;
	minWidth?: number;
	maxWidth?: number;
	focused?: boolean;
}

interface FrameLayout {
	frameWidth: number;
	contentWidth: number;
}

function resolveLayout(availableWidth: number, options: ZellijFrameOptions): FrameLayout {
	const safeAvailableWidth = Math.max(1, Math.floor(availableWidth));
	const requestedMinWidth = Math.max(1, Math.floor(options.minWidth ?? 1));
	const requestedMaxWidth = Math.max(1, Math.floor(options.maxWidth ?? safeAvailableWidth));
	const maxWidth = Math.max(1, Math.min(requestedMaxWidth, safeAvailableWidth));
	const minWidth = Math.min(requestedMinWidth, maxWidth);
	const clampedWidth = Math.max(minWidth, Math.min(maxWidth, safeAvailableWidth));
	return {
		frameWidth: clampedWidth,
		contentWidth: Math.max(1, clampedWidth - 2),
	};
}

function safeLabel(text: string, maxWidth: number): string {
	const cleaned = normalizeInlineText(text).trim();
	if (!cleaned) {
		return "";
	}
	return truncateToWidth(cleaned, Math.max(1, maxWidth), "…", true);
}

function buildTopLine(
	layout: FrameLayout,
	options: ZellijFrameOptions,
	theme: FrameThemeLike,
	glyphs: BorderGlyphSet,
): string {
	const innerWidth = layout.contentWidth;
	const borderColor = options.focused === false ? "muted" : "accent";
	const safeLeft = safeLabel(options.titleLeft, Math.max(1, innerWidth));
	if (!safeLeft) {
		const border = glyphs.horizontal.repeat(Math.max(0, innerWidth));
		return `${theme.fg(borderColor, glyphs.topLeft)}${theme.fg(borderColor, border)}${theme.fg(borderColor, glyphs.topRight)}`;
	}

	const paddedTitle =
		innerWidth >= visibleWidth(safeLeft) + 2 ? ` ${theme.bold(safeLeft)} ` : theme.bold(safeLeft);
	const titleWidth = innerWidth >= visibleWidth(safeLeft) + 2 ? visibleWidth(safeLeft) + 2 : visibleWidth(safeLeft);
	const fillWidth = Math.max(0, innerWidth - titleWidth);
	return `${theme.fg(borderColor, glyphs.topLeft)}${paddedTitle}${theme.fg(borderColor, glyphs.horizontal.repeat(fillWidth))}${theme.fg(borderColor, glyphs.topRight)}`;
}

function buildBottomLine(
	layout: FrameLayout,
	options: ZellijFrameOptions,
	theme: FrameThemeLike,
	glyphs: BorderGlyphSet,
): string {
	const innerWidth = layout.contentWidth;
	const borderColor = options.focused === false ? "muted" : "accent";
	const safeHelp = safeLabel(options.helpText ?? "", Math.max(1, innerWidth - 3));

	if (!safeHelp) {
		return `${theme.fg(borderColor, glyphs.bottomLeft)}${theme.fg(borderColor, glyphs.horizontal.repeat(innerWidth))}${theme.fg(borderColor, glyphs.bottomRight)}`;
	}
	const helpWidth = visibleWidth(safeHelp);
	const rightFillWidth = Math.max(0, innerWidth - helpWidth - 3);

	return `${theme.fg(borderColor, glyphs.bottomLeft)}${theme.fg(borderColor, glyphs.horizontal)} ${theme.fg("dim", safeHelp)} ${theme.fg(borderColor, glyphs.horizontal.repeat(rightFillWidth))}${theme.fg(borderColor, glyphs.bottomRight)}`;
}

function wrapContentLines(
	lines: string[],
	layout: FrameLayout,
	theme: FrameThemeLike,
	focused: boolean,
	glyphs: BorderGlyphSet,
): string[] {
	const borderColor = focused ? "accent" : "muted";
	const rendered = lines.length > 0 ? lines : [""];

	return rendered.map((line) => {
		const singleLine = normalizeInlineText(line);
		const fitted = truncateToWidth(singleLine, layout.contentWidth, "…", true);
		const missing = Math.max(0, layout.contentWidth - visibleWidth(fitted));
		const padded = `${fitted}${" ".repeat(missing)}`;
		return `${theme.fg(borderColor, glyphs.vertical)}${padded}${theme.fg(borderColor, glyphs.vertical)}`;
	});
}

export function renderZellijFrame(
	contentLines: string[],
	availableWidth: number,
	theme: FrameThemeLike,
	options: ZellijFrameOptions,
): { lines: string[]; contentWidth: number } {
	const layout = resolveLayout(availableWidth, options);
	const focused = options.focused !== false;
	const glyphs = resolveBorderGlyphs();
	const frameLines: string[] = [];

	frameLines.push(buildTopLine(layout, options, theme, glyphs));
	frameLines.push(...wrapContentLines(contentLines, layout, theme, focused, glyphs));
	frameLines.push(buildBottomLine(layout, options, theme, glyphs));

	return {
		lines: frameLines,
		contentWidth: layout.contentWidth,
	};
}

export function renderZellijFrameWithRenderer(
	availableWidth: number,
	theme: FrameThemeLike,
	options: ZellijFrameOptions,
	renderContent: (contentWidth: number) => string[],
): { lines: string[]; contentWidth: number } {
	const layout = resolveLayout(availableWidth, options);
	const contentLines = renderContent(layout.contentWidth);
	return renderZellijFrame(contentLines, availableWidth, theme, options);
}
