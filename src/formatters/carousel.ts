import { truncateToWidth } from "@mariozechner/pi-tui";

const ITEM_SEPARATOR = " │ ";

function joinedWidth(items: string[], start: number, end: number): number {
	if (start > end) {
		return 0;
	}
	let width = 0;
	for (let index = start; index <= end; index += 1) {
		width += items[index]?.length ?? 0;
		if (index < end) {
			width += ITEM_SEPARATOR.length;
		}
	}
	return width;
}

function fitWindow(items: string[], selectedIndex: number, maxWidth: number): { start: number; end: number } {
	if (items.length === 0) {
		return { start: 0, end: -1 };
	}

	let best: { start: number; end: number; visibleCount: number; centerDistance: number } | null = null;

	for (let start = 0; start <= selectedIndex; start += 1) {
		for (let end = selectedIndex; end < items.length; end += 1) {
			const leftIndicatorWidth = start > 0 ? 2 : 0;
			const rightIndicatorWidth = end < items.length - 1 ? 2 : 0;
			const width = leftIndicatorWidth + joinedWidth(items, start, end) + rightIndicatorWidth;
			if (width > maxWidth) {
				continue;
			}

			const visibleCount = end - start + 1;
			const centerDistance = Math.abs((start + end) / 2 - selectedIndex);
			if (
				!best ||
				visibleCount > best.visibleCount ||
				(visibleCount === best.visibleCount && centerDistance < best.centerDistance)
			) {
				best = { start, end, visibleCount, centerDistance };
			}
		}
	}

	if (!best) {
		return { start: selectedIndex, end: selectedIndex };
	}

	return {
		start: best.start,
		end: best.end,
	};
}

export function renderProviderTabsLine(
	providers: readonly string[],
	selectedProvider: string,
	maxWidth: number,
): string {
	if (providers.length === 0) {
		return "";
	}

	const tokens = providers.map((provider) =>
		provider === selectedProvider ? `[ * ${provider} ]` : provider,
	);
	const normalizedMaxWidth = Math.max(8, maxWidth);
	const selectedIndex = Math.max(0, providers.indexOf(selectedProvider));

	const { start, end } = fitWindow(tokens, selectedIndex, normalizedMaxWidth);
	const hiddenLeft = start > 0;
	const hiddenRight = end < tokens.length - 1;
	const visibleTokens = tokens.slice(start, end + 1);
	const line = `${hiddenLeft ? "< " : ""}${visibleTokens.join(ITEM_SEPARATOR)}${hiddenRight ? " >" : ""}`;

	if (line.length > normalizedMaxWidth) {
		const selectedToken = tokens[selectedIndex] ?? "";
		return truncateToWidth(selectedToken, normalizedMaxWidth, "…", true);
	}

	return line;
}

export function renderCarouselLine(items: string[], selectedIndex: number, maxWidth: number): string {
	if (items.length === 0) {
		return "";
	}

	const normalizedMaxWidth = Math.max(8, maxWidth);
	const clampedSelectedIndex = Math.max(0, Math.min(items.length - 1, selectedIndex));
	const { start, end } = fitWindow(items, clampedSelectedIndex, normalizedMaxWidth);

	const hiddenLeft = start > 0;
	const hiddenRight = end < items.length - 1;
	const visibleItems = items.slice(start, end + 1);
	const line = `${hiddenLeft ? "< " : ""}${visibleItems.join(ITEM_SEPARATOR)}${hiddenRight ? " >" : ""}`;

	if (line.length > normalizedMaxWidth) {
		const selectedItem = items[clampedSelectedIndex] ?? "";
		return truncateToWidth(selectedItem, normalizedMaxWidth, "…", true);
	}

	return line;
}

export function toFixedLineCount(lines: string[], count: number): string[] {
	const normalizedCount = Math.max(0, count);
	if (lines.length === normalizedCount) {
		return lines;
	}

	if (lines.length > normalizedCount) {
		return lines.slice(0, normalizedCount);
	}

	const padded = [...lines];
	while (padded.length < normalizedCount) {
		padded.push("");
	}
	return padded;
}
