export interface StreamTimeoutConfig {
	attemptTimeoutMs: number;
	idleTimeoutMs: number;
}

export const DEFAULT_STREAM_TIMEOUT_CONFIG: StreamTimeoutConfig = {
	attemptTimeoutMs: 600_000,
	idleTimeoutMs: 45_000,
};
