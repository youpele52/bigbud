import { describe, expect, it, vi } from "vitest";

import {
  RemoteAgentRemoteCommandError,
  runRemoteAgentDiagnosedCommand,
} from "./remoteAgentDiagnostics.ts";
import {
  makeRemoteAgentInstallOperations,
  type RemoteAgentOperationDependencies,
} from "./remoteAgentInstall.operation.ts";
import { RemoteAgentCapacityUnavailableError } from "./remoteAgentInstall.stage.ts";

const target = "ssh:host=example&transport=agent";

function operations(overrides: Partial<RemoteAgentOperationDependencies> = {}) {
  const dependencies = {
    stage: vi.fn(async () => ({ version: "0.3.4" })),
    activate: vi.fn(async () => ({ currentVersion: "0.3.4" })),
    retire: vi.fn(async () => ({ deferred: 0 })),
    ...overrides,
  };
  return { dependencies, operations: makeRemoteAgentInstallOperations(dependencies) };
}

async function complete(input: ReturnType<typeof operations>, replace = false) {
  const started = input.operations.start({ executionTargetId: target, replace });
  return (await input.operations.wait(started.operationId, 5_000))!;
}

describe("shared remote agent install operation", () => {
  it("reconciles a lost initial reply by caller ID without staging twice", async () => {
    const fixture = operations();
    const input = {
      executionTargetId: target,
      replace: false,
      operationId: "00000000-0000-4000-8000-000000000001",
    };
    const accepted = fixture.operations.start(input);
    await fixture.operations.wait(accepted.operationId, 5000);
    expect(fixture.operations.start(input)).toMatchObject({
      operationId: input.operationId,
      outcome: "active",
    });
    expect(fixture.dependencies.stage).toHaveBeenCalledTimes(1);
    expect(() => fixture.operations.start({ ...input, executionTargetId: "ssh:other" })).toThrow(
      "another request",
    );
  });

  it("keeps activation loss uncertain after a simulated remote commit", async () => {
    let committed = false;
    const fixture = operations({
      activate: async () => {
        committed = true;
        await runRemoteAgentDiagnosedCommand(
          async () => ({ code: 255, stderr: "Connection reset" }),
          "install",
          { executionTargetId: target, command: "sh" },
        );
        return { currentVersion: "0.3.4" };
      },
    });
    expect(await complete(fixture, true)).toMatchObject({ outcome: "uncertain" });
    expect(committed).toBe(true);
    expect(fixture.dependencies.stage).toHaveBeenCalledOnce();
    expect(fixture.dependencies.retire).not.toHaveBeenCalled();
  });

  it.each([255, null])(
    "keeps a lost SSH result (%s) uncertain without activation",
    async (code) => {
      const fixture = operations({
        stage: vi.fn(async () => {
          await runRemoteAgentDiagnosedCommand(
            async () => ({
              code,
              signal: code === null ? "SIGTERM" : null,
              stderr: "client_loop: send disconnect: Broken pipe",
            }),
            "install",
            { executionTargetId: target, command: "sh" },
          );
          return { version: "0.3.4" };
        }),
      });
      expect(await complete(fixture)).toMatchObject({ outcome: "uncertain" });
      expect(fixture.dependencies.activate).not.toHaveBeenCalled();
      expect(fixture.dependencies.retire).not.toHaveBeenCalled();
    },
  );

  it("stages, activates and reports active without retiring for a plain install", async () => {
    const fixture = operations();
    const result = await complete(fixture);
    expect(result).toMatchObject({
      state: "completed",
      outcome: "active",
      version: "0.3.4",
      activeVersion: "0.3.4",
      cleanupDeferred: false,
    });
    expect(fixture.dependencies.activate).toHaveBeenCalledWith(target, result.operationId);
    expect(fixture.dependencies.retire).not.toHaveBeenCalled();
  });

  it("reports active with cleanup deferred when live work pins a predecessor", async () => {
    const fixture = operations({ retire: vi.fn(async () => ({ deferred: 1 })) });
    const result = await complete(fixture, true);
    expect(result).toMatchObject({ outcome: "active", cleanupDeferred: true, kind: "replace" });
    expect(result.message).toContain("Cleanup of older builds is deferred");
  });

  it("reports activation deferred when the previous build keeps serving", async () => {
    const fixture = operations({
      activate: vi.fn(async () => ({ currentVersion: "0.3.3", warning: "Health check failed." })),
    });
    const result = await complete(fixture, true);
    expect(result).toMatchObject({ outcome: "deferred", activeVersion: "0.3.3" });
    expect(fixture.dependencies.retire).not.toHaveBeenCalled();
  });

  it("reports a cleanup failure separately from live work pinning old builds", async () => {
    const fixture = operations({
      retire: vi.fn(async () => {
        throw new Error("registry lock busy");
      }),
    });
    const result = await complete(fixture, true);
    expect(result).toMatchObject({ outcome: "active", cleanupDeferred: true });
    expect(result.message).toContain("could not run and is deferred");
    expect(result.message).not.toContain("live work");
  });

  it("compares exact builds: a same-version fallback build is deferred, not active", async () => {
    const musl = "0.3.4:aa:x86_64-unknown-linux-musl";
    const glibc = "0.3.4:bb:x86_64-unknown-linux-gnu";
    const fallback = operations({
      stage: vi.fn(async () => ({ version: "0.3.4", buildId: musl })),
      activate: vi.fn(async () => ({ currentVersion: "0.3.4", currentBuildId: glibc })),
    });
    const deferred = await complete(fallback, true);
    expect(deferred).toMatchObject({ outcome: "deferred", activeVersion: "0.3.4" });
    expect(deferred.message).toContain("another 0.3.4 build remains active");
    expect(fallback.dependencies.retire).not.toHaveBeenCalled();
    const exact = operations({
      stage: vi.fn(async () => ({ version: "0.3.4", buildId: musl })),
      activate: vi.fn(async () => ({ currentVersion: "0.3.4", currentBuildId: musl })),
    });
    expect((await complete(exact)).outcome).toBe("active");
  });

  it("maps capacity to deferred, timeouts to uncertain and other failures to failed", async () => {
    const capacity = operations({
      stage: vi.fn(async () => {
        throw new RemoteAgentCapacityUnavailableError("waiting-for-capacity");
      }),
    });
    expect((await complete(capacity)).outcome).toBe("deferred");
    const timeout = operations({
      stage: vi.fn(async () => {
        throw new RemoteAgentRemoteCommandError("install", null, true, "");
      }),
    });
    expect(await complete(timeout)).toMatchObject({
      outcome: "uncertain",
      failureKind: "upload-timeout",
    });
    const failed = operations({
      activate: vi.fn(async () => {
        throw new Error("handshake refused");
      }),
    });
    expect(await complete(failed)).toMatchObject({ outcome: "failed", version: "0.3.4" });
  });

  it("joins a running operation for the same target instead of launching another", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = operations({
      stage: vi.fn(async () => {
        await gate;
        return { version: "0.3.4" };
      }),
    });
    const first = fixture.operations.start({ executionTargetId: target, replace: false });
    const second = fixture.operations.start({ executionTargetId: target, replace: true });
    expect(second.operationId).toBe(first.operationId);
    expect((await fixture.operations.wait(first.operationId, 10))?.state).toBe("running");
    release();
    expect((await fixture.operations.wait(first.operationId, 5_000))?.outcome).toBe("active");
    expect(fixture.dependencies.stage).toHaveBeenCalledOnce();
    expect(fixture.operations.get("missing")).toBeNull();
  });
});
