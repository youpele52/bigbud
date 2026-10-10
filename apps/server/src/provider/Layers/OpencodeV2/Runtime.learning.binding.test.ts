import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { makeV2LearningReview } from "./Runtime.learning.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import type { V2IsolatedRuntimeOptions } from "./Runtime.types.ts";

for (const runtimeTarget of ["local", "ssh:synthetic-runtime"]) {
  it(`reuses terminal learning through the same prepared ${runtimeTarget} binding without native admission`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      const synthetic = path.join(directory, "synthetic");
      await mkdir(synthetic);
      let preparedDirectory = synthetic;
      const cleanup = vi.fn(async () => {});
      const prepareSession: NonNullable<V2IsolatedRuntimeOptions["prepareSession"]> = async (
        input,
        _signal,
        disableTools,
      ) => {
        expect(disableTools).toBe(true);
        return {
          input: { ...input, cwd: preparedDirectory },
          options: {
            ...runtime.options,
            config: { ...runtime.options.config, runtimeTargetId: runtimeTarget },
            remoteSessionConformance: {
              providerRuntimeTargetId: runtimeTarget,
              workspaceTargetId: "ssh:synthetic-workspace",
              profileRoot: runtime.options.config.profileRoot,
              syntheticDirectory: preparedDirectory,
            },
          },
          resources: { cleanup },
        };
      };
      const owned = new OpencodeV2Runtime({ ...runtime.options, prepareSession });
      const request = {
        ownerThreadId: ThreadId.makeUnsafe("prepared-learning-owner"),
        jobId: "prepared-job",
        cwd: "/remote/workspace",
        providerRuntimeExecutionTargetId: runtimeTarget,
        workspaceExecutionTargetId: "ssh:synthetic-workspace",
        modelSelection: {
          provider: "opencodeV2" as const,
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        },
        input: "durable prepared learning",
      };
      try {
        const review = makeV2LearningReview(owned);
        const result = await Effect.runPromise(review(request));
        const calls = http.calls.length;
        const acquire = vi.spyOn(runtime.options.manager, "acquire");
        expect(await Effect.runPromise(review(request))).toBe(result);
        expect(acquire).not.toHaveBeenCalled();
        expect(http.calls).toHaveLength(calls);
        expect(cleanup).toHaveBeenCalledTimes(2);
        preparedDirectory = directory; // Same job must not silently follow a different prepared Location.
        expect((await Effect.runPromise(review(request).pipe(Effect.result)))._tag).toBe("Failure");
        expect(
          (await Effect.runPromise(review({ ...request, input: "changed" }).pipe(Effect.result)))
            ._tag,
        ).toBe("Failure");
        expect(http.calls).toHaveLength(calls);
        expect(acquire).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(4);
      } finally {
        await owned.close();
      }
    });
  });
}

it("terminal binding preparation receives cancellation without acquiring or admitting native work", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const request = {
      ownerThreadId: ThreadId.makeUnsafe("cancelled-terminal-learning"),
      jobId: "cancelled-binding-job",
      cwd: directory,
      modelSelection: {
        provider: "opencodeV2" as const,
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
      input: "terminal learning cancellation",
    };
    const review = makeV2LearningReview(runtime);
    await Effect.runPromise(review(request));
    const calls = http.calls.length;
    const acquire = vi.spyOn(runtime.options.manager, "acquire");
    let cancellation: AbortSignal | undefined;
    Object.assign(runtime.options, {
      prepareSession: (_input: unknown, signal: AbortSignal) => {
        cancellation = signal;
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    });
    const result = await Effect.runPromise(
      review(request).pipe(Effect.timeout("30 millis"), Effect.result),
    );
    expect(result._tag).toBe("Failure");
    expect(cancellation?.aborted).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
    expect(http.calls).toHaveLength(calls);
  });
});
