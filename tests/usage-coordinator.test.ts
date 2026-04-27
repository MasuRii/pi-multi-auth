import assert from "node:assert/strict";
import test from "node:test";
import { UsageService } from "../src/usage/index.js";
import { UsageCoordinator, type UsageCoordinationConfig } from "../src/usage/usage-coordinator.js";
import type { UsageAuth, UsageSnapshot } from "../src/usage/types.js";

function createConfig(overrides: Partial<UsageCoordinationConfig> = {}): UsageCoordinationConfig {
	return {
		enabled: true,
		globalMaxConcurrentFreshRequests: 2,
		perProviderMaxConcurrentFreshRequests: 1,
		selectionCandidateWindow: 2,
		blockedReconciliationCandidateWindow: 2,
		entitlementCandidateWindow: 2,
		startupCandidateWindow: 1,
		modalRefreshCandidateWindow: 2,
		manualProviderRefreshCandidateWindow: 2,
		accountCooldownMs: 0,
		providerCooldownMs: 0,
		circuitBreakerFailureThreshold: 3,
		circuitBreakerCooldownMs: 0,
		jitterMs: 0,
		...overrides,
	};
}

function createUsageSnapshot(provider: string): UsageSnapshot {
	const now = Date.now();
	return {
		timestamp: now,
		provider,
		planType: null,
		primary: null,
		secondary: null,
		credits: null,
		copilotQuota: null,
		updatedAt: now,
	};
}

function createCredentialRef(index: number): string {
	return `id:${index.toString(16).padStart(8, "0")}`;
}

function createCredentialRequests(count: number): Array<{ provider: string; credentialId: string }> {
	return Array.from({ length: count }, (_unused, index) => ({
		provider: "bounded-provider",
		credentialId: createCredentialRef(index),
	}));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolveDeferred: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolveDeferred = resolve;
	});
	if (!resolveDeferred) {
		throw new Error("Failed to initialize deferred usage coordination gate.");
	}
	return { promise, resolve: resolveDeferred };
}

test("usage coordinator bounds high-cardinality request windows", () => {
	const coordinator = new UsageCoordinator(createConfig({ modalRefreshCandidateWindow: 2 }));
	const selected = coordinator.selectCredentialRequests(
		[
			{ provider: "provider", credentialId: "credential-a" },
			{ provider: "provider", credentialId: "credential-a" },
			{ provider: "provider", credentialId: "credential-b" },
			{ provider: "provider", credentialId: "credential-c" },
		],
		"modal-refresh",
	);

	assert.deepEqual(
		selected.map((request) => request.credentialId),
		["credential-a", "credential-b"],
	);
});

test("usage coordinator progresses 14 modal refresh credentials with window 8", () => {
	const windowSize = 8;
	const coordinator = new UsageCoordinator(
		createConfig({ modalRefreshCandidateWindow: windowSize }),
	);
	const requests = createCredentialRequests(14);

	const first = coordinator.selectCredentialRequests(requests, "modal-refresh");
	const second = coordinator.selectCredentialRequests(requests, "modal-refresh");
	const coveredCredentialIds = new Set(
		[...first, ...second].map((request) => request.credentialId),
	);

	assert.equal(first.length, windowSize);
	assert.equal(second.length, windowSize);
	assert.deepEqual(
		first.map((request) => request.credentialId),
		Array.from({ length: windowSize }, (_unused, index) => createCredentialRef(index)),
	);
	assert.deepEqual(
		second.map((request) => request.credentialId),
		[
			...Array.from({ length: 6 }, (_unused, index) => createCredentialRef(index + windowSize)),
			createCredentialRef(0),
			createCredentialRef(1),
		],
	);
	assert.equal(coveredCredentialIds.size, requests.length);
	for (const request of requests) {
		assert.equal(coveredCredentialIds.has(request.credentialId), true);
	}
});

test("usage coordinator dedupes provider credential pairs before progressive modal windows", () => {
	const coordinator = new UsageCoordinator(createConfig({ modalRefreshCandidateWindow: 3 }));
	const requests = [
		{ provider: "provider-a", credentialId: "shared" },
		{ provider: "provider-a", credentialId: "shared" },
		{ provider: "provider-b", credentialId: "shared" },
		{ provider: "provider-a", credentialId: "credential-a" },
		{ provider: "provider-a", credentialId: "credential-b" },
		{ provider: "provider-b", credentialId: "credential-c" },
	];

	const first = coordinator.selectCredentialRequests(requests, "modal-refresh");
	const second = coordinator.selectCredentialRequests(requests, "modal-refresh");
	const selectedPairs = [...first, ...second].map(
		(request) => `${request.provider}:${request.credentialId}`,
	);

	assert.equal(first.length, 3);
	assert.equal(second.length, 3);
	assert.equal(new Set(first.map((request) => `${request.provider}:${request.credentialId}`)).size, 3);
	assert.equal(new Set(second.map((request) => `${request.provider}:${request.credentialId}`)).size, 3);
	assert.equal(new Set(selectedPairs).size, 5);
});

test("usage coordinator handles modal refresh inventory changes without exceeding the window", () => {
	const coordinator = new UsageCoordinator(createConfig({ modalRefreshCandidateWindow: 4 }));

	coordinator.selectCredentialRequests(createCredentialRequests(10), "modal-refresh");
	coordinator.selectCredentialRequests(createCredentialRequests(10), "modal-refresh");
	const reduced = coordinator.selectCredentialRequests(createCredentialRequests(3), "modal-refresh");
	const expanded = coordinator.selectCredentialRequests(createCredentialRequests(6), "modal-refresh");
	const progressed = coordinator.selectCredentialRequests(createCredentialRequests(6), "modal-refresh");

	assert.equal(reduced.length, 3);
	assert.deepEqual(
		reduced.map((request) => request.credentialId),
		Array.from({ length: 3 }, (_unused, index) => createCredentialRef(index)),
	);
	assert.equal(expanded.length, 4);
	assert.deepEqual(
		expanded.map((request) => request.credentialId),
		Array.from({ length: 4 }, (_unused, index) => createCredentialRef(index)),
	);
	assert.equal(progressed.length, 4);
	assert.deepEqual(
		progressed.map((request) => request.credentialId),
		[createCredentialRef(4), createCredentialRef(5), createCredentialRef(0), createCredentialRef(1)],
	);
});

test("usage coordinator keeps 50, 100, and 500 credential windows bounded", async (t) => {
	const windowSize = 8;
	const selectionCount = 10;
	for (const credentialCount of [50, 100, 500]) {
		await t.test(`${credentialCount} credentials`, () => {
			const coordinator = new UsageCoordinator(
				createConfig({ modalRefreshCandidateWindow: windowSize }),
			);
			const requests = createCredentialRequests(credentialCount);
			const selections = Array.from({ length: selectionCount }, () =>
				coordinator.selectCredentialRequests(requests, "modal-refresh"),
			);

			for (const selected of selections) {
				assert.equal(selected.length <= windowSize, true);
			}
			assert.deepEqual(
				selections[0].map((request) => request.credentialId),
				Array.from({ length: windowSize }, (_unused, index) => createCredentialRef(index)),
			);
			assert.equal(selections[1][0]?.credentialId, createCredentialRef(windowSize));
			assert.equal(
				new Set(selections.flat().map((request) => request.credentialId)).size,
				Math.min(credentialCount, windowSize * selectionCount),
			);
		});
	}
});

test("usage coordinator re-checks cooldown policy before dispatching queued requests", async () => {
	const coordinator = new UsageCoordinator(
		createConfig({
			globalMaxConcurrentFreshRequests: 1,
			perProviderMaxConcurrentFreshRequests: 1,
			accountCooldownMs: 60_000,
			providerCooldownMs: 60_000,
			jitterMs: 0,
		}),
	);
	const firstGate = createDeferred();
	let queuedRunCount = 0;

	const first = coordinator.executeFreshRequest(
		{ provider: "cooldown-provider", credentialId: createCredentialRef(1), operation: "direct" },
		async () => {
			await firstGate.promise;
			throw new Error("429 rate limit");
		},
	);
	const queued = coordinator.executeFreshRequest(
		{ provider: "cooldown-provider", credentialId: createCredentialRef(2), operation: "direct" },
		async () => {
			queuedRunCount += 1;
			return "unexpected-dispatch";
		},
	);

	const firstRejection = assert.rejects(first, /429 rate limit/);
	const queuedRejection = assert.rejects(queued, /provider usage cooldown is active/);
	firstGate.resolve();
	await firstRejection;
	await queuedRejection;
	assert.equal(queuedRunCount, 0);
});

test("usage coordinator re-checks circuit policy before dispatching queued requests", async () => {
	const coordinator = new UsageCoordinator(
		createConfig({
			globalMaxConcurrentFreshRequests: 1,
			perProviderMaxConcurrentFreshRequests: 1,
			accountCooldownMs: 60_000,
			circuitBreakerCooldownMs: 60_000,
			jitterMs: 0,
		}),
	);
	const firstGate = createDeferred();
	let queuedRunCount = 0;

	const first = coordinator.executeFreshRequest(
		{ provider: "circuit-provider", credentialId: createCredentialRef(1), operation: "direct" },
		async () => {
			await firstGate.promise;
			throw new Error("401 unauthorized");
		},
	);
	const queued = coordinator.executeFreshRequest(
		{ provider: "circuit-provider", credentialId: createCredentialRef(2), operation: "direct" },
		async () => {
			queuedRunCount += 1;
			return "unexpected-dispatch";
		},
	);

	const firstRejection = assert.rejects(first, /401 unauthorized/);
	const queuedRejection = assert.rejects(queued, /provider circuit is open/);
	firstGate.resolve();
	await firstRejection;
	await queuedRejection;
	assert.equal(queuedRunCount, 0);
});

test("usage service preserves single-flight fresh usage requests under coordination", async () => {
	let fetchCount = 0;
	const coordinator = new UsageCoordinator(createConfig());
	const usageService = new UsageService(30_000, 300_000, 10_000, coordinator, { persistentCache: false });
	usageService.register({
		id: "single-flight-provider",
		displayName: "Single Flight Provider",
		fetchUsage: async (_auth: UsageAuth) => {
			fetchCount += 1;
			return createUsageSnapshot("single-flight-provider");
		},
	});

	const [first, second] = await Promise.all([
		usageService.fetchUsage(
			"single-flight-provider",
			"credential-a",
			{ accessToken: "token-a" },
			{ forceRefresh: true, coordinationOperation: "modal-refresh" },
		),
		usageService.fetchUsage(
			"single-flight-provider",
			"credential-a",
			{ accessToken: "token-a" },
			{ forceRefresh: true, coordinationOperation: "modal-refresh" },
		),
	]);

	assert.equal(fetchCount, 1);
	assert.equal(first.fromCache, false);
	assert.equal(second.fromCache, false);
	assert.equal(first.error, null);
	assert.equal(second.error, null);
});
