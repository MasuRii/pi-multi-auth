import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthWriter } from "../src/auth-writer.js";
import { KeyDistributor } from "../src/balancer/key-distributor.js";
import { LightweightRotationState } from "../src/lightweight-rotation-state.js";
import type { ProviderCapabilities } from "../src/provider-registry.js";
import { resolveProviderRotationClassification } from "../src/provider-rotation-profile.js";
import { getProviderState, MultiAuthStorage } from "../src/storage.js";

test("resolveProviderRotationClassification keeps lightweight rotation provider-agnostic", () => {
	assert.deepEqual(
		resolveProviderRotationClassification(" custom-provider ", { supportsOAuth: false }),
		{
			hasExternalAccountState: false,
			rotationProfile: "lightweight",
		},
	);

	assert.deepEqual(
		resolveProviderRotationClassification("custom-provider", { supportsOAuth: true }),
		{
			hasExternalAccountState: false,
			rotationProfile: "standard",
		},
	);

	assert.deepEqual(
		resolveProviderRotationClassification("anthropic", { supportsOAuth: false }),
		{
			hasExternalAccountState: true,
			rotationProfile: "standard",
		},
	);
});

test("LightweightRotationState stages and flushes lightweight provider updates", async () => {
	const providerId = "custom-provider";
	const credentialIds = ["custom-provider:1", "custom-provider:2"] as const;
	const selectedAt = 1_717_171_717_000;
	const tempDir = await mkdtemp(join(tmpdir(), "pi-multi-auth-lightweight-"));
	const storage = new MultiAuthStorage(join(tempDir, "multi-auth.json"), {
		debugDir: join(tempDir, "debug"),
	});
	const rotationState = new LightweightRotationState(storage, {
		flushIntervalMs: 60_000,
		maxPendingSelections: 8,
	});

	const poolState = {
		activePoolId: "pool-a",
		poolIndex: 1,
	};
	const cascadeState = {
		[providerId]: {
			active: {
				cascadeId: "cascade-1",
				cascadePath: [
					{
						providerId,
						credentialId: credentialIds[1],
						attemptedAt: selectedAt,
						errorKind: "rate_limit" as const,
						errorMessage: "rate limited",
						recoveryAction: "cooldown" as const,
					},
				],
				attemptCount: 1,
				startedAt: selectedAt,
				lastAttemptAt: selectedAt,
				nextRetryAt: selectedAt + 60_000,
				isActive: true,
			},
			history: [],
		},
	};
	const healthState = {
		scores: {
			[credentialIds[1]]: {
				credentialId: credentialIds[1],
				score: 0.82,
				calculatedAt: selectedAt,
				components: {
					successRate: 0.9,
					latencyFactor: 0.8,
					uptimeFactor: 0.85,
					recoveryFactor: 0.75,
				},
				isStale: false,
			},
		},
	};

	try {
		await storage.withLock((state) => {
			const providerState = getProviderState(state, providerId);
			providerState.credentialIds = [...credentialIds];
			providerState.rotationMode = "balancer";
			providerState.activeIndex = 0;
			return { result: undefined, next: state };
		});

		rotationState.recordSelection({
			providerId,
			credentialIds,
			credentialId: credentialIds[1],
			selectedIndex: 1,
			nextActiveIndex: 1,
			selectedAt,
			poolState,
		});
		rotationState.recordTelemetry({
			providerId,
			credentialIds,
			cascadeState,
			healthState,
		});

		const projectedState = rotationState.applyToProviderState(
			providerId,
			await storage.readProviderState(providerId),
		);
		assert.equal(projectedState.activeIndex, 1);
		assert.equal(projectedState.usageCount[credentialIds[1]], 1);
		assert.equal(projectedState.lastUsedAt[credentialIds[1]], selectedAt);
		assert.deepEqual(projectedState.poolState, poolState);
		assert.deepEqual(projectedState.cascadeState, cascadeState);
		assert.deepEqual(projectedState.healthState, healthState);

		const persistedBeforeFlush = await storage.readProviderState(providerId);
		assert.equal(persistedBeforeFlush.activeIndex, 0);
		assert.equal(persistedBeforeFlush.usageCount[credentialIds[1]] ?? 0, 0);
		assert.equal(persistedBeforeFlush.lastUsedAt[credentialIds[1]] ?? 0, 0);
		assert.equal(persistedBeforeFlush.poolState, undefined);
		assert.equal(persistedBeforeFlush.cascadeState, undefined);
		assert.equal(persistedBeforeFlush.healthState, undefined);

		await rotationState.flushProvider(providerId);

		const persistedAfterFlush = await storage.readProviderState(providerId);
		assert.equal(persistedAfterFlush.activeIndex, 1);
		assert.equal(persistedAfterFlush.usageCount[credentialIds[1]], 1);
		assert.equal(persistedAfterFlush.lastUsedAt[credentialIds[1]], selectedAt);
		assert.deepEqual(persistedAfterFlush.poolState, poolState);
		assert.deepEqual(persistedAfterFlush.cascadeState, cascadeState);
		assert.deepEqual(persistedAfterFlush.healthState, healthState);
	} finally {
		rotationState.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("KeyDistributor bypasses delegated subagent acquisition when only one credential remains structurally eligible", async () => {
	const providerId = "cline";
	const tempDir = await mkdtemp(join(tmpdir(), "pi-multi-auth-delegation-bypass-"));
	const storage = new MultiAuthStorage(join(tempDir, "multi-auth.json"), {
		debugDir: join(tempDir, "debug"),
	});
	const authWriter = new AuthWriter(join(tempDir, "auth.json"));
	const distributor = new KeyDistributor(storage, authWriter, {
		waitTimeoutMs: 25,
		maxConcurrentPerKey: 1,
	});

	try {
		distributor.setProviderCapabilitiesResolver((currentProviderId) => ({
			provider: currentProviderId,
			supportsApiKey: true,
			supportsOAuth: currentProviderId === providerId,
			hasExternalAccountState: false,
			rotationProfile: "standard",
		}));
		await authWriter.setApiKeyCredential(providerId, "workos:valid-token");
		await storage.withLock((state) => {
			const providerState = getProviderState(state, providerId);
			providerState.credentialIds = [providerId];
			providerState.rotationMode = "balancer";
			providerState.activeIndex = 0;
			return { result: undefined, next: state };
		});

		const initialLease = await distributor.acquireForSubagent("child-1", providerId, {
			parentSessionId: "parent-a",
		});
		assert.equal(initialLease.credentialId, providerId);

		assert.equal(
			await distributor.shouldBypassDelegatedSubagentAcquisition(providerId, {
				modelId: "moonshotai/kimi-k2.6",
			}),
			true,
		);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("KeyDistributor reuses lightweight parent-session leases and invalidates them on cooldown", async () => {
	const providerId = "custom-provider";
	const credentialIds = [providerId, `${providerId}-1`] as const;
	const tempDir = await mkdtemp(join(tmpdir(), "pi-multi-auth-lightweight-lease-"));
	const storage = new MultiAuthStorage(join(tempDir, "multi-auth.json"), {
		debugDir: join(tempDir, "debug"),
	});
	const authWriter = new AuthWriter(join(tempDir, "auth.json"));
	const distributor = new KeyDistributor(storage, authWriter, {
		waitTimeoutMs: 25,
		maxConcurrentPerKey: 1,
	});
	const providerCapabilities: ProviderCapabilities = {
		provider: providerId,
		supportsApiKey: true,
		supportsOAuth: false,
		hasExternalAccountState: false,
		rotationProfile: "lightweight",
	};
	const originalRandom = Math.random;
	Math.random = () => 0;

	try {
		distributor.setProviderCapabilitiesResolver(() => providerCapabilities);
		await authWriter.setApiKeyCredential(credentialIds[0], "key-a");
		await authWriter.setApiKeyCredential(credentialIds[1], "key-b");
		await storage.withLock((state) => {
			const providerState = getProviderState(state, providerId);
			providerState.credentialIds = [...credentialIds];
			providerState.rotationMode = "balancer";
			providerState.activeIndex = 0;
			return { result: undefined, next: state };
		});

		const firstLease = await distributor.acquireForSubagent("child-1", providerId, {
			parentSessionId: "parent-a",
		});
		assert.equal(firstLease.credentialId, credentialIds[0]);
		distributor.releaseFromSubagent("child-1");

		const reusedLease = await distributor.acquireForSubagent("child-2", providerId, {
			parentSessionId: "parent-a",
		});
		assert.equal(reusedLease.credentialId, firstLease.credentialId);
		distributor.releaseFromSubagent("child-2");

		await distributor.applyCooldown(
			firstLease.credentialId,
			60_000,
			"transient-provider-error",
			providerId,
			false,
			"temporary upstream failure",
		);

		const replacementLease = await distributor.acquireForSubagent("child-3", providerId, {
			parentSessionId: "parent-a",
		});
		assert.equal(replacementLease.credentialId, credentialIds[1]);
		distributor.releaseFromSubagent("child-3");
	} finally {
		Math.random = originalRandom;
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("KeyDistributor releases lightweight parent-session leases explicitly and preserves standard provider behavior", async () => {
	const lightweightProviderId = "custom-provider";
	const standardProviderId = "oauth-provider";
	const tempDir = await mkdtemp(join(tmpdir(), "pi-multi-auth-lightweight-release-"));
	const storage = new MultiAuthStorage(join(tempDir, "multi-auth.json"), {
		debugDir: join(tempDir, "debug"),
	});
	const authWriter = new AuthWriter(join(tempDir, "auth.json"));
	const distributor = new KeyDistributor(storage, authWriter, {
		waitTimeoutMs: 25,
		maxConcurrentPerKey: 1,
	});
	const originalRandom = Math.random;
	Math.random = () => 0;

	try {
		distributor.setProviderCapabilitiesResolver((providerId) => ({
			provider: providerId,
			supportsApiKey: true,
			supportsOAuth: providerId === standardProviderId,
			hasExternalAccountState: providerId === standardProviderId,
			rotationProfile: providerId === lightweightProviderId ? "lightweight" : "standard",
		}));

		await authWriter.setApiKeyCredential(lightweightProviderId, "lightweight-key-a");
		await authWriter.setApiKeyCredential(`${lightweightProviderId}-1`, "lightweight-key-b");
		await authWriter.setApiKeyCredential(standardProviderId, "standard-key-a");
		await authWriter.setApiKeyCredential(`${standardProviderId}-1`, "standard-key-b");
		await storage.withLock((state) => {
			const lightweightState = getProviderState(state, lightweightProviderId);
			lightweightState.credentialIds = [lightweightProviderId, `${lightweightProviderId}-1`];
			lightweightState.rotationMode = "balancer";
			lightweightState.activeIndex = 0;

			const standardState = getProviderState(state, standardProviderId);
			standardState.credentialIds = [standardProviderId, `${standardProviderId}-1`];
			standardState.rotationMode = "balancer";
			standardState.activeIndex = 0;
			return { result: undefined, next: state };
		});

		const parentALease = await distributor.acquireForSubagent("lightweight-child-1", lightweightProviderId, {
			parentSessionId: "parent-a",
		});
		assert.equal(parentALease.credentialId, lightweightProviderId);
		distributor.releaseFromSubagent("lightweight-child-1");

		const parentBLease = await distributor.acquireForSubagent("lightweight-child-2", lightweightProviderId, {
			parentSessionId: "parent-b",
		});
		assert.equal(parentBLease.credentialId, `${lightweightProviderId}-1`);
		distributor.releaseFromSubagent("lightweight-child-2");

		await assert.rejects(
			distributor.acquireForSubagent("lightweight-child-3", lightweightProviderId, {
				parentSessionId: "parent-c",
			}),
			/time(d)? out/i,
		);

		distributor.releaseLightweightSessionLeases("parent-a");
		const parentCLease = await distributor.acquireForSubagent("lightweight-child-3", lightweightProviderId, {
			parentSessionId: "parent-c",
		});
		assert.equal(parentCLease.credentialId, lightweightProviderId);
		distributor.releaseFromSubagent("lightweight-child-3");

		const standardLeaseA = await distributor.acquireForSubagent("standard-child-1", standardProviderId, {
			parentSessionId: "standard-parent",
		});
		const standardLeaseB = await distributor.acquireForSubagent("standard-child-2", standardProviderId, {
			parentSessionId: "standard-parent",
		});
		assert.notEqual(standardLeaseA.credentialId, standardLeaseB.credentialId);
		distributor.releaseFromSubagent("standard-child-1");
		distributor.releaseFromSubagent("standard-child-2");
	} finally {
		Math.random = originalRandom;
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("KeyDistributor honors standard round-robin rotation for delegated subagents and persists shared state", async () => {
	const providerId = "oauth-round-robin-provider";
	const credentialIds = [providerId, `${providerId}-1`, `${providerId}-2`] as const;
	const tempDir = await mkdtemp(join(tmpdir(), "pi-multi-auth-standard-round-robin-"));
	const storage = new MultiAuthStorage(join(tempDir, "multi-auth.json"), {
		debugDir: join(tempDir, "debug"),
	});
	const authWriter = new AuthWriter(join(tempDir, "auth.json"));
	const distributor = new KeyDistributor(storage, authWriter, {
		waitTimeoutMs: 25,
		maxConcurrentPerKey: 1,
	});

	try {
		distributor.setProviderCapabilitiesResolver((provider) => ({
			provider,
			supportsApiKey: true,
			supportsOAuth: true,
			hasExternalAccountState: false,
			rotationProfile: "standard",
		}));

		for (const credentialId of credentialIds) {
			await authWriter.setApiKeyCredential(credentialId, `${credentialId}-secret`);
		}
		await storage.withLock((state) => {
			const providerState = getProviderState(state, providerId);
			providerState.credentialIds = [...credentialIds];
			providerState.rotationMode = "round-robin";
			providerState.activeIndex = 0;
			return { result: undefined, next: state };
		});

		const firstLease = await distributor.acquireForSubagent("round-robin-child-1", providerId);
		distributor.releaseFromSubagent("round-robin-child-1");
		const secondLease = await distributor.acquireForSubagent("round-robin-child-2", providerId);
		distributor.releaseFromSubagent("round-robin-child-2");
		const thirdLease = await distributor.acquireForSubagent("round-robin-child-3", providerId);
		distributor.releaseFromSubagent("round-robin-child-3");

		assert.deepEqual(
			[firstLease.credentialId, secondLease.credentialId, thirdLease.credentialId],
			[credentialIds[0], credentialIds[1], credentialIds[2]],
		);

		const persistedState = await storage.readProviderState(providerId);
		assert.equal(persistedState.activeIndex, 0);
		assert.deepEqual(
			credentialIds.map((credentialId) => persistedState.usageCount[credentialId] ?? 0),
			[1, 1, 1],
		);
		for (const credentialId of credentialIds) {
			assert.ok((persistedState.lastUsedAt[credentialId] ?? 0) > 0);
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("KeyDistributor honors standard usage-based rotation for delegated subagents and persists shared state", async () => {
	const providerId = "oauth-usage-provider";
	const credentialIds = [providerId, `${providerId}-1`, `${providerId}-2`] as const;
	const tempDir = await mkdtemp(join(tmpdir(), "pi-multi-auth-standard-usage-"));
	const storage = new MultiAuthStorage(join(tempDir, "multi-auth.json"), {
		debugDir: join(tempDir, "debug"),
	});
	const authWriter = new AuthWriter(join(tempDir, "auth.json"));
	const distributor = new KeyDistributor(storage, authWriter, {
		waitTimeoutMs: 25,
		maxConcurrentPerKey: 1,
	});

	try {
		distributor.setProviderCapabilitiesResolver((provider) => ({
			provider,
			supportsApiKey: true,
			supportsOAuth: true,
			hasExternalAccountState: false,
			rotationProfile: "standard",
		}));

		for (const credentialId of credentialIds) {
			await authWriter.setApiKeyCredential(credentialId, `${credentialId}-secret`);
		}
		await storage.withLock((state) => {
			const providerState = getProviderState(state, providerId);
			providerState.credentialIds = [...credentialIds];
			providerState.rotationMode = "usage-based";
			providerState.activeIndex = 0;
			providerState.usageCount[credentialIds[0]] = 5;
			providerState.usageCount[credentialIds[1]] = 1;
			providerState.usageCount[credentialIds[2]] = 0;
			providerState.lastUsedAt[credentialIds[0]] = 300;
			providerState.lastUsedAt[credentialIds[1]] = 200;
			providerState.lastUsedAt[credentialIds[2]] = 100;
			return { result: undefined, next: state };
		});

		const lease = await distributor.acquireForSubagent("usage-child-1", providerId);
		distributor.releaseFromSubagent("usage-child-1");
		assert.equal(lease.credentialId, credentialIds[2]);

		const persistedState = await storage.readProviderState(providerId);
		assert.equal(persistedState.activeIndex, 2);
		assert.equal(persistedState.usageCount[credentialIds[2]], 1);
		assert.ok((persistedState.lastUsedAt[credentialIds[2]] ?? 0) > 100);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("KeyDistributor serializes standard delegated acquisition critical sections", async () => {
	const providerId = "oauth-concurrency-provider";
	const tempDir = await mkdtemp(join(tmpdir(), "pi-multi-auth-standard-concurrency-"));
	const storage = new MultiAuthStorage(join(tempDir, "multi-auth.json"), {
		debugDir: join(tempDir, "debug"),
	});
	const authWriter = new AuthWriter(join(tempDir, "auth.json"));
	const distributor = new KeyDistributor(storage, authWriter, {
		waitTimeoutMs: 50,
		maxConcurrentPerKey: 1,
	});
	const distributorWithHooks = distributor as unknown as {
		acquireCredentialId: KeyDistributor["acquireCredentialId"];
	};
	const originalAcquireCredentialId = distributorWithHooks.acquireCredentialId.bind(distributor);
	let activeAcquireCalls = 0;
	let peakConcurrentAcquireCalls = 0;

	try {
		distributor.setProviderCapabilitiesResolver((provider) => ({
			provider,
			supportsApiKey: true,
			supportsOAuth: true,
			hasExternalAccountState: false,
			rotationProfile: "standard",
		}));

		distributorWithHooks.acquireCredentialId = async (...args) => {
			activeAcquireCalls += 1;
			peakConcurrentAcquireCalls = Math.max(peakConcurrentAcquireCalls, activeAcquireCalls);
			await new Promise((resolve) => setTimeout(resolve, 25));
			try {
				return await originalAcquireCredentialId(...args);
			} finally {
				activeAcquireCalls -= 1;
			}
		};

		await authWriter.setApiKeyCredential(providerId, `${providerId}-secret`);
		await authWriter.setApiKeyCredential(`${providerId}-1`, `${providerId}-1-secret`);
		await storage.withLock((state) => {
			const providerState = getProviderState(state, providerId);
			providerState.credentialIds = [providerId, `${providerId}-1`];
			providerState.rotationMode = "round-robin";
			providerState.activeIndex = 0;
			return { result: undefined, next: state };
		});

		const [firstResult, secondResult] = await Promise.allSettled([
			distributor.acquireForSubagent("concurrency-child-1", providerId),
			distributor.acquireForSubagent("concurrency-child-2", providerId),
		]);

		assert.equal(firstResult.status, "fulfilled");
		assert.equal(secondResult.status, "fulfilled");
		assert.equal(peakConcurrentAcquireCalls, 1);
		if (firstResult.status === "fulfilled") {
			distributor.releaseFromSubagent("concurrency-child-1");
		}
		if (secondResult.status === "fulfilled") {
			distributor.releaseFromSubagent("concurrency-child-2");
		}
	} finally {
		distributorWithHooks.acquireCredentialId = originalAcquireCredentialId;
		await rm(tempDir, { recursive: true, force: true });
	}
});
