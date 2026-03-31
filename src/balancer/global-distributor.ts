import { KeyDistributor } from "./key-distributor.js";

type GlobalWithKeyDistributor = typeof globalThis & {
	__piMultiAuthKeyDistributor?: KeyDistributor;
};

/**
 * Registers a shared KeyDistributor instance on globalThis.
 */
export function registerGlobalKeyDistributor(distributor: KeyDistributor): KeyDistributor {
	const globalScope = globalThis as GlobalWithKeyDistributor;
	globalScope.__piMultiAuthKeyDistributor = distributor;
	return distributor;
}

/**
 * Clears the globally registered KeyDistributor instance.
 */
export function unregisterGlobalKeyDistributor(distributor?: KeyDistributor): void {
	const globalScope = globalThis as GlobalWithKeyDistributor;
	if (
		distributor !== undefined &&
		globalScope.__piMultiAuthKeyDistributor !== undefined &&
		globalScope.__piMultiAuthKeyDistributor !== distributor
	) {
		return;
	}
	delete globalScope.__piMultiAuthKeyDistributor;
}

/**
 * Returns the globally registered KeyDistributor instance.
 */
export function getGlobalKeyDistributor(): KeyDistributor | null {
	const globalScope = globalThis as GlobalWithKeyDistributor;
	return globalScope.__piMultiAuthKeyDistributor ?? null;
}
