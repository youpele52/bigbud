import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { restartRemoteAgent } from "./remoteAgentRestart.operation.ts";
import { makeMemoryStore } from "./remoteAgentRestart.store.ts";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { validateRemoteAgentRuntime, remoteAgentBuildId } from "./remoteAgentRuntime.ts";

const sha256 = "a".repeat(64);
const runtime = validateRemoteAgentRuntime({
  generation: "g-recovery",
  version: "0.3.3",
  sha256,
  buildDigest: "fixture",
  targetTriple: "aarch64-unknown-linux-musl",
  origin: "managed",
  binaryPath: `/tmp/agent/bin/0.3.3/${sha256}/bigbud-remote-agent`,
  statePath: "/tmp/agent/runtimes/g-recovery",
  socketPath: "/tmp/agent/runtimes/g-recovery/supervisor.sock",
  logPath: "/tmp/agent/runtimes/g-recovery/supervisor.log",
});
const request = {
  requestId: "restart:request with spaces",
  projectId: "project" as never,
  expectedWorkspaceExecutionTargetId: "ssh:fixture" as never,
};
const attemptId = `restart-${createHash("sha256").update(request.requestId).digest("hex").slice(0, 48)}`;

describe("restart durable recovery", () => {
  it.each(["old-epoch", "new-epoch", "interleaved", "remote-commit", "local-commit"])(
    "recovers a lost reply with cached %s binding without another stop or launch",
    async (cachedEpoch) => {
      const store = makeMemoryStore();
      await store.put({
        requestId: request.requestId,
        projectId: request.projectId,
        target: "ssh:fixture",
        runtime,
        oldEpoch: "old-epoch",
        phase: "starting",
        message: "Starting",
      });
      let registry = parseRemoteAgentRegistry(
        JSON.stringify({
          ...emptyRemoteAgentRegistry(),
          builds: [
            {
              id: remoteAgentBuildId(runtime),
              runtime,
              health: "healthy",
              promotion: 1,
              binary: "present",
              authenticated: true,
            },
          ],
          promotionSequence: 1,
          current: remoteAgentBuildId(runtime),
          launches: [
            {
              id: runtime.generation,
              buildId: remoteAgentBuildId(runtime),
              attemptId,
              phase: "spawn-uncertain",
              epoch: "old-epoch",
            },
          ],
          restartReservations: [
            {
              id: request.requestId,
              buildId: remoteAgentBuildId(runtime),
              generation: runtime.generation,
              expectedEpoch: "old-epoch",
              phase: "starting",
            },
          ],
        }),
      );
      let injected = false;
      const updateStore = store.update;
      vi.spyOn(store, "update").mockImplementation(async (id, transition) =>
        updateStore(id, (current) => {
          const next = transition(current);
          if (cachedEpoch === "local-commit" && !injected && next.phase === "ready") {
            injected = true;
            throw new Error("lost local completion");
          }
          return next;
        }),
      );
      const run = vi.fn(async () => "ready");
      const launchReplacement = vi.fn(async () => {
        throw new Error("Recovery must never start another account unit.");
      });
      const reconnect = vi.fn(async () => {
        expect(["starting", "ready"]).toContain(registry.restartReservations[0]?.phase);
        if (cachedEpoch === "interleaved")
          registry = parseRemoteAgentRegistry(
            JSON.stringify({
              ...registry,
              currentConnectionId: null,
              admissions: [],
              launches: registry.launches.map((entry) => ({
                ...entry,
                attemptId: "other-attempt",
                epoch: "other-epoch",
              })),
            }),
          );
      });
      const resolveBinding = vi.fn(async () => ({ runtime, expectedEpoch: cachedEpoch }));
      const dependencies: Parameters<typeof restartRemoteAgent>[0] = {
        store,
        launchReplacement,
        resolveBinding,
        verifySsh: async () => undefined,
        verifyReadiness: async () => "new-epoch",
        reconnect,
        close: vi.fn(),
        control: async () => ({
          run,
          registry: {
            update: async (transition) => {
              registry = parseRemoteAgentRegistry(JSON.stringify(transition(registry)));
              if (
                cachedEpoch === "remote-commit" &&
                !injected &&
                registry.restartReservations[0]?.phase === "ready"
              ) {
                injected = true;
                throw new Error("lost remote completion");
              }
              return registry;
            },
          },
        }),
      };
      let operation = restartRemoteAgent(dependencies, request);
      if (cachedEpoch === "remote-commit" || cachedEpoch === "local-commit") {
        await expect(operation).rejects.toThrow("completion needs reconciliation");
        expect(registry.restartReservations[0]?.phase).toBe("ready");
        expect((await store.get(request.requestId))?.phase).toBe("starting");
        operation = restartRemoteAgent(dependencies, request);
      }
      if (cachedEpoch === "interleaved") {
        await expect(operation).rejects.toThrow("completion needs reconciliation");
        expect(registry.launches[0]).toMatchObject({
          attemptId: "other-attempt",
          epoch: "other-epoch",
        });
        expect((await store.get(request.requestId))?.phase).toBe("starting");
        return;
      }
      const result = await operation;
      expect(result).toMatchObject({
        phase: "ready",
        oldEpoch: "old-epoch",
        replacementEpoch: "new-epoch",
      });
      expect(launchReplacement).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(injected ? 2 : 1);
      expect(run.mock.calls[0]).toBeDefined();
      expect(reconnect).toHaveBeenCalledWith(
        "ssh:fixture",
        { runtime, expectedEpoch: "new-epoch", connectionId: attemptId },
        { runtime, expectedEpoch: "old-epoch" },
      );
      expect(registry.launches[0]).toMatchObject({ phase: "ready", epoch: "new-epoch", attemptId });
    },
  );
});
