import { describe, expect, it, vi } from "vitest";
import { Deferred, Effect, Option } from "effect";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ProviderControlsSnapshot } from "@bigbud/contracts/server/providerControls";
import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import { makeProviderControls } from "./ProviderService.controls.ts";
import { makeThreadOperations } from "./ProviderService.threadOperations.ts";
import { coordinateProviderControls } from "./ProviderService.controls.admission.ts";
import { unavailableProviderControls } from "../providerControls.ts";
import { CODEX_REWIND_KEY } from "../Services/ProviderRewind.ts";
import { INSPECTION_TERMINAL_KEY } from "../Services/ProviderInspectionTerminal.ts";

const input = {
  threadId: ThreadId.makeUnsafe("chat"),
  sessionEpoch: 2,
  action: "compact" as const,
};
function harness() {
  const binding: ProviderRuntimeBinding = {
    threadId: input.threadId,
    provider: "codex",
    resumeCursor: { threadId: "native" },
    runtimePayload: { sessionEpoch: 2 },
  };
  let current: ProviderRuntimeBinding | undefined = binding;
  let session = { ...binding, sessionEpoch: 2, status: "ready" };
  const snapshot: ProviderControlsSnapshot = {
    ...unavailableProviderControls(input, ""),
    compact: { available: true, reason: "" },
    mcpStatus: { available: true, reason: "" },
    mcpReload: { available: true, reason: "" },
  };
  const controls = vi.fn(() => Effect.succeed(snapshot));
  const refresh = vi.fn(() => Effect.succeed([{ name: "native", status: "connected" as const }]));
  const reloadAll = vi.fn(() =>
    Effect.succeed({
      ...snapshot,
      reloadState: "failed" as const,
      message: "Partially applied",
      servers: [{ name: "native", status: "failed" as const }],
    }),
  );
  const directory = {
    getBinding: () => Effect.sync(() => Option.fromUndefinedOr(current)),
  } as unknown as ProviderSessionDirectoryShape;
  const registry = {
    getByProvider: vi.fn(() =>
      Effect.succeed({
        controls,
        listSessions: () => Effect.succeed(session.status === "absent" ? [] : [session]),
        mcp: { refresh, reloadAll },
      }),
    ),
  } as unknown as ProviderAdapterRegistryShape;
  const publish = vi.fn(() => Effect.void);
  const run = coordinateProviderControls(
    makeProviderControls(registry, directory, publish),
    makeThreadOperations(directory),
  );
  return {
    binding,
    snapshot,
    controls,
    refresh,
    reloadAll,
    publish,
    run,
    directory,
    setBinding: (next: ProviderRuntimeBinding | undefined) => {
      current = next;
    },
    setSession: (next: Partial<typeof session>) => {
      session = { ...session, ...next };
    },
  };
}

describe("coordinated current-session maintenance", () => {
  it("does not dispatch compact when durable proof storage/acknowledgment is unavailable", async () => {
    const test = harness();
    const result = await Effect.runPromise(test.run(input));
    expect(test.controls).toHaveBeenCalledWith({ ...input, action: "status" });
    expect(result.compact.available).toBe(false);
    expect(result.compact.reason).toContain("Durable");
    expect(result.mcpStatus.available).toBe(true);
  });
  it.each([
    "unknown",
    "other-provider",
    "stopped",
    "absent",
    "stale-epoch",
    "native-owner",
    "target",
  ])("disables %s without native calls or recovery", async (mode) => {
    const test = harness();
    if (mode === "unknown") test.setBinding(undefined);
    if (mode === "other-provider") test.setBinding({ ...test.binding, provider: "claudeAgent" });
    if (mode === "stopped") test.setSession({ status: "closed" });
    if (mode === "absent") test.setSession({ status: "absent" });
    if (mode === "stale-epoch") test.setSession({ sessionEpoch: 3 });
    if (mode === "native-owner") test.setSession({ resumeCursor: { threadId: "different" } });
    if (mode === "target")
      test.setBinding({ ...test.binding, executionTargetId: "remote" as never });
    const result = await Effect.runPromise(test.run(input));
    expect(result.compact.available).toBe(false);
    expect(test.controls).not.toHaveBeenCalled();
    expect(test.reloadAll).not.toHaveBeenCalled();
  });
  it.each([CODEX_REWIND_KEY, INSPECTION_TERMINAL_KEY])(
    "blocks durable %s without native side effects",
    async (key) => {
      const test = harness();
      test.setBinding({
        ...test.binding,
        runtimePayload: { sessionEpoch: 2, [key]: { incomplete: true } },
      });
      const result = await Effect.runPromise(test.run(input));
      expect(result.compact.available).toBe(false);
      expect(test.controls).not.toHaveBeenCalled();
    },
  );
  it("uses optional neutral MCP operations and publishes only the fenced redacted result", async () => {
    const test = harness();
    const refreshed = await Effect.runPromise(test.run({ ...input, action: "refresh-mcp" }));
    expect(test.refresh).toHaveBeenCalledWith(input.threadId);
    expect(refreshed.servers).toEqual([{ name: "native", status: "connected" }]);
    const reloaded = await Effect.runPromise(test.run({ ...input, action: "reload-mcp" }));
    expect(test.reloadAll).toHaveBeenCalledWith(input.threadId, 2);
    expect(reloaded.reloadState).toBe("failed");
    expect(reloaded.message).toBe("Partially applied");
    expect(test.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "mcp.status.updated",
        sessionEpoch: 2,
        payload: { status: reloaded.servers },
      }),
    );
  });
  it("discards results on a replaced binding after async provider work", async () => {
    const test = harness();
    test.controls.mockImplementation(() =>
      Effect.sync(() => {
        test.setBinding({ ...test.binding, runtimePayload: { sessionEpoch: 3 } });
        return test.snapshot;
      }),
    );
    await expect(Effect.runPromise(test.run(input))).rejects.toThrow("changed");
    expect(test.publish).not.toHaveBeenCalled();
  });
  it("rejects concurrent duplicate compact/reload rather than queuing either mutation", async () => {
    const test = harness();
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    test.controls.mockImplementation(() =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(test.snapshot),
      ),
    );
    const first = Effect.runPromise(test.run(input));
    await Effect.runPromise(Deferred.await(entered));
    await expect(Effect.runPromise(test.run(input))).rejects.toThrow("already in progress");
    await expect(Effect.runPromise(test.run({ ...input, action: "reload-mcp" }))).rejects.toThrow(
      "already in progress",
    );
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await first;
    expect(test.controls).toHaveBeenCalledTimes(1);
    expect(test.reloadAll).not.toHaveBeenCalled();
  });
});
