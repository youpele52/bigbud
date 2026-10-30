import { describe, expect, it, vi } from "vitest";
import { Deferred, Effect, Option } from "effect";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { exactRewindInput } from "../../codex/codexAppServerManager.reliability.test.helpers.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
import { CODEX_REWIND_KEY, type CodexRewindMarker } from "../Services/ProviderRewind.ts";
import { makeRewindConversation } from "./ProviderService.rewind.ts";
import { makeThreadOperations } from "./ProviderService.threadOperations.ts";

function harness(failure?: "marker" | "native" | "files" | "verify" | "canonical") {
  let marker: CodexRewindMarker | null = null;
  const binding: ProviderRuntimeBinding = {
    threadId: exactRewindInput.threadId,
    provider: "codex",
    resumeCursor: { threadId: "native" },
    runtimePayload: { sessionEpoch: 2 },
  };
  const stages: string[] = [];
  const directory = {
    getBinding: () =>
      Effect.sync(() =>
        Option.some({
          ...binding,
          runtimePayload: { sessionEpoch: 2, [CODEX_REWIND_KEY]: marker },
        }),
      ),
    setCodexRewind: (_threadId: ThreadId, next: CodexRewindMarker | null) =>
      Effect.sync(() => {
        if (failure === "marker") throw new Error("storage failed");
        marker = next;
        stages.push(next?.stage ?? "cleared");
      }),
  } as unknown as ProviderSessionDirectoryShape;
  const prepareRewind = vi.fn(() =>
    Effect.succeed({ nativeThreadId: "native", runtimeVersion: "0.166.0" }),
  );
  const revertThread = vi.fn(() =>
    failure === "native" ? Effect.die("hydration failed") : Effect.void,
  );
  const verifyRewind = vi.fn(() =>
    failure === "verify" ? Effect.die("post-files divergence") : Effect.void,
  );
  const registry = {
    getByProvider: () => Effect.succeed({ prepareRewind, revertThread, verifyRewind }),
  } as unknown as ProviderAdapterRegistryShape;
  const rewind = makeRewindConversation(registry, directory);
  const run = makeThreadOperations(directory);
  const restoreFiles = vi.fn(() =>
    failure === "files" ? Effect.die("filesystem failed") : Effect.void,
  );
  const completeCanonical = vi.fn(() =>
    failure === "canonical" ? Effect.die("publication failed") : Effect.void,
  );
  const execute = () =>
    run(
      exactRewindInput.threadId,
      rewind(exactRewindInput, {
        preflight: Effect.void,
        restoreFiles: Effect.suspend(restoreFiles),
        completeCanonical: Effect.suspend(completeCanonical),
      }),
    );
  return {
    directory,
    stages,
    execute,
    revertThread,
    restoreFiles,
    completeCanonical,
    marker: () => marker,
  };
}

describe("coordinated durable Codex rewind", () => {
  it("persists every stage before advancing and clears only after canonical completion", async () => {
    const test = harness();
    await Effect.runPromise(test.execute());
    expect(test.stages).toEqual([
      "prepared",
      "dispatched-uncertain",
      "native-verified",
      "files-restored",
      "canonical-complete",
      "cleared",
    ]);
    expect(test.revertThread).toHaveBeenCalledTimes(1);
    expect(test.restoreFiles).toHaveBeenCalledTimes(1);
    expect(test.completeCanonical).toHaveBeenCalledTimes(1);
  });

  it.each(["native", "files", "verify", "canonical"] as const)(
    "retains the marker after %s failure and blocks replay after coordinator recreation",
    async (failure) => {
      const test = harness(failure);
      await expect(Effect.runPromise(test.execute())).rejects.toThrow();
      expect(test.marker()).not.toBeNull();
      await expect(Effect.runPromise(test.execute())).rejects.toThrow("blocked");
      const recreated = makeThreadOperations(test.directory);
      const dispatch = vi.fn();
      await expect(
        Effect.runPromise(recreated(exactRewindInput.threadId, Effect.sync(dispatch))),
      ).rejects.toThrow("blocked");
      expect(dispatch).not.toHaveBeenCalled();
      expect(test.revertThread).toHaveBeenCalledTimes(1);
      if (failure === "native") expect(test.restoreFiles).not.toHaveBeenCalled();
      if (failure !== "canonical") expect(test.completeCanonical).not.toHaveBeenCalled();
    },
  );

  it("never dispatches a native mutation when preparing durable storage fails", async () => {
    const test = harness("marker");
    await expect(Effect.runPromise(test.execute())).rejects.toThrow("storage failed");
    expect(test.revertThread).not.toHaveBeenCalled();
  });

  it("holds the same thread lease through asynchronous completion and rechecks queued sends", async () => {
    const test = harness();
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const run = makeThreadOperations(test.directory);
    const first = Effect.runPromise(
      run(
        exactRewindInput.threadId,
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          yield* test.directory.setCodexRewind!(
            exactRewindInput.threadId,
            {
              ...exactRewindInput,
              nativeThreadId: "native",
              runtimeVersion: "0.166.0",
              stage: "dispatched-uncertain",
            },
            "operation",
          );
        }),
      ),
    );
    await Effect.runPromise(Deferred.await(entered));
    const dispatch = vi.fn();
    const second = Effect.runPromise(run(exactRewindInput.threadId, Effect.sync(dispatch)));
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await first;
    await expect(second).rejects.toThrow("blocked");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
