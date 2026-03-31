import { AsyncBufferedLogWriter } from "./async-buffered-log-writer.js";
import {
	CONFIG_PATH,
	DEBUG_DIR,
	DEBUG_LOG_PATH,
	MULTI_AUTH_EXTENSION_ID,
	ensureMultiAuthDebugDirectory,
	loadMultiAuthConfig,
} from "./config.js";

export interface MultiAuthDebugLoggerOptions {
	configPath?: string;
	debugDir?: string;
	logPath?: string;
}

function safeJsonStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, (_key, currentValue) => {
		if (currentValue instanceof Error) {
			return {
				name: currentValue.name,
				message: currentValue.message,
				stack: currentValue.stack,
			};
		}

		if (typeof currentValue === "bigint") {
			return currentValue.toString();
		}

		if (typeof currentValue === "object" && currentValue !== null) {
			if (seen.has(currentValue)) {
				return "[Circular]";
			}
			seen.add(currentValue);
		}

		return currentValue;
	});
}

export class MultiAuthDebugLogger {
	private initialized = false;
	private readonly writer: AsyncBufferedLogWriter;

	constructor(private readonly options: MultiAuthDebugLoggerOptions = {}) {
		this.writer = new AsyncBufferedLogWriter({
			enabled: false,
			logPath: this.options.logPath ?? DEBUG_LOG_PATH,
			ensureDirectory: () => ensureMultiAuthDebugDirectory(this.options.debugDir ?? DEBUG_DIR),
			createDroppedEntriesLine: (droppedEntries) =>
				`${safeJsonStringify({
					timestamp: new Date().toISOString(),
					level: "warn",
					extension: MULTI_AUTH_EXTENSION_ID,
					event: "debug_log_overflow",
					droppedEntries,
				})}\n`,
		});
	}

	private initialize(): void {
		if (this.initialized) {
			return;
		}

		this.initialized = true;
		const configResult = loadMultiAuthConfig(this.options.configPath ?? CONFIG_PATH);
		this.writer.setEnabled(configResult.config.debug);
	}

	log(event: string, payload: Record<string, unknown> = {}): void {
		try {
			this.initialize();
			this.writer.writeLine(
				`${safeJsonStringify({
					timestamp: new Date().toISOString(),
					level: "debug",
					extension: MULTI_AUTH_EXTENSION_ID,
					event,
					...payload,
				})}\n`,
			);
		} catch {
			// Debug log failures must never affect credential rotation.
		}
	}

	flush(): Promise<void> {
		return this.writer.flush();
	}
}

export const multiAuthDebugLogger = new MultiAuthDebugLogger();
