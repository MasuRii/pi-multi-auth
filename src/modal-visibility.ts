import type { OverlayHandle } from "@mariozechner/pi-tui";

/**
 * Manages temporary modal hiding while nested UI dialogs are active.
 */
export class ModalVisibilityController {
	private overlayHandle: OverlayHandle | null = null;
	private hiddenDepth = 0;

	attach(handle: OverlayHandle): void {
		this.overlayHandle = handle;
		this.syncVisibility();
	}

	detach(): void {
		this.overlayHandle = null;
		this.hiddenDepth = 0;
	}

	async withHidden<T>(action: () => Promise<T>): Promise<T> {
		this.hiddenDepth += 1;
		this.syncVisibility();

		try {
			return await action();
		} finally {
			this.hiddenDepth = Math.max(0, this.hiddenDepth - 1);
			this.syncVisibility();
		}
	}

	private syncVisibility(): void {
		if (!this.overlayHandle) {
			return;
		}

		const shouldHide = this.hiddenDepth > 0;
		try {
			this.overlayHandle.setHidden(shouldHide);
		} catch {
			// Overlay might already be disposed while an async flow is still settling.
		}
	}
}
