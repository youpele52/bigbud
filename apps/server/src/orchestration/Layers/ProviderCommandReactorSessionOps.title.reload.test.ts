import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { TextGenerationError } from "@bigbud/contracts";
import { titleFixture } from "./ProviderCommandReactorSessionOps.title.fixture.ts";
import {
  hasUnresolvedTitleGeneration,
  readTitleStage,
  recordTitleStage,
} from "./ProviderCommandReactorSessionOps.title.state.ts";
import { recordThreadTextGenerationStatusRequired } from "../../git/Layers/InternalTextGeneration.status.ts";
import { resetThreadTitleLockForTests } from "../../orchestration-tools/ThreadTitleLock.ts";

const status = (
  f: ReturnType<typeof titleFixture>,
  state: "uncertain" | "started" | "failed",
  context = {},
) =>
  Effect.runPromise(
    recordThreadTextGenerationStatusRequired(
      f.services.orchestrationEngine,
      f.thread.id,
      "title",
      state,
      context,
    ),
  );
const stage = (
  f: ReturnType<typeof titleFixture>,
  state: "started" | "failed" | "uncertain",
  protectedUncertainty = false,
) =>
  Effect.runPromise(
    recordTitleStage(f.services, f.thread, 1, state, undefined, protectedUncertainty),
  );

describe("automatic titles through production-sorted projection reloads", () => {
  afterEach(resetThreadTitleLockForTests);

  it("settles a clean first title and never mistakes its sorted start for unresolved work", async () => {
    const f = titleFixture();
    f.generate.mockReturnValue(Effect.succeed({ title: "Investigate reconnect behavior" }));
    await Effect.runPromise(f.run());
    f.reload();
    expect(readTitleStage(f.thread, 1)?.state).toBe("completed");
    expect(hasUnresolvedTitleGeneration(f.thread)).toBe(false);
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.thread.title).toBe("Investigate reconnect behavior");
    expect(f.thread.activities.some((item) => item.kind === "text-generation.uncertain")).toBe(
      false,
    );
  });

  it("retains failed settlements across reload and advances only after three verified user turns", async () => {
    const f = titleFixture();
    await Effect.runPromise(f.run());
    f.reload();
    expect(readTitleStage(f.thread, 1)?.state).toBe("failed");
    expect(readTitleStage(f.thread, 2)?.state).toBe("failed");
    f.addSuccess(1);
    f.addSuccess(2);
    f.reload();
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(2);
    f.addSuccess(3);
    f.generate.mockReturnValue(Effect.succeed({ title: "Recover verified thread title" }));
    f.reload();
    await Effect.runPromise(f.run());
    f.reload();
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(3);
    expect(f.thread.title).toBe("Recover verified thread title");
  });

  it("recognizes historical false uncertainty only with the same stage's definitive settlement", async () => {
    const f = titleFixture();
    await Effect.runPromise(f.run());
    await stage(f, "uncertain");
    await status(f, "uncertain");
    f.reload();
    expect(hasUnresolvedTitleGeneration(f.thread)).toBe(false);
    f.addSuccess(1);
    f.addSuccess(2);
    f.addSuccess(3);
    f.generate.mockReturnValue(Effect.succeed({ title: "Recover historically blocked title" }));
    await Effect.runPromise(f.run());
    f.reload();
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(3);
    expect(f.thread.title).toBe("Recover historically blocked title");
    // Read-time repair does not delete the original diagnostic history.
    expect(f.thread.activities.some((item) => item.kind === "text-generation.uncertain")).toBe(
      true,
    );
  });

  it("does not replay completed work even when legacy false uncertainty is present", async () => {
    const f = titleFixture();
    f.generate.mockReturnValue(Effect.succeed({ title: "Keep completed generated title" }));
    await Effect.runPromise(f.run());
    await stage(f, "uncertain");
    await status(f, "uncertain");
    f.reload();
    expect(hasUnresolvedTitleGeneration(f.thread)).toBe(false);
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("preserves actual unresolved starts and is idempotent across repeated reloads", async () => {
    const f = titleFixture();
    await stage(f, "started");
    f.reload();
    await Effect.runPromise(f.run());
    f.reload();
    await Effect.runPromise(f.run());
    expect(hasUnresolvedTitleGeneration(f.thread)).toBe(true);
    expect(readTitleStage(f.thread, 1)?.state).toBe("uncertain");
    expect(f.generate).not.toHaveBeenCalled();
    expect(
      f.thread.activities.filter((item) => item.kind === "text-generation.uncertain"),
    ).toHaveLength(1);
  });

  it.each(["protected-stage", "native-id", "unsettled-native-claim", "missing-stage-witness"])(
    "does not repair genuine or uncorrelated uncertainty: %s",
    async (reason) => {
      const f = titleFixture();
      await stage(f, "started");
      if (reason !== "missing-stage-witness") await stage(f, "failed");
      await stage(f, "uncertain", reason === "protected-stage");
      if (reason === "unsettled-native-claim")
        await status(f, "started", { uncertaintyProtected: true });
      await status(
        f,
        "uncertain",
        reason === "native-id" ? { uncertaintyId: "native-session-proof" } : {},
      );
      f.addSuccess(1);
      f.addSuccess(2);
      f.addSuccess(3);
      f.reload();
      expect(hasUnresolvedTitleGeneration(f.thread)).toBe(true);
      await Effect.runPromise(f.run());
      expect(f.generate).not.toHaveBeenCalled();
    },
  );

  it("marks provider uncertainty as protected instead of treating it as inferred legacy state", async () => {
    const f = titleFixture();
    f.generate.mockReturnValue(
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          kind: "uncertain",
          detail: "Unknown dispatch result",
        }),
      ),
    );
    await Effect.runPromise(f.run());
    f.reload();
    expect(readTitleStage(f.thread, 1)).toMatchObject({
      state: "uncertain",
      uncertaintyProtected: true,
    });
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("keeps bounded recovery and durable redacted failure evidence after reload", async () => {
    const f = titleFixture();
    f.generate.mockReturnValue(
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          kind: "provider",
          detail: `Rejected endpoint https://example.test/private token=private-secret ${"x".repeat(800)}`,
        }),
      ),
    );
    await Effect.runPromise(f.run());
    f.addSuccess(1);
    f.addSuccess(2);
    f.addSuccess(3);
    await Effect.runPromise(f.run());
    f.reload();
    await Effect.runPromise(f.run());
    expect(f.generate).toHaveBeenCalledTimes(4);
    const failed = f.thread.activities.filter(
      (item) =>
        item.kind === "text-generation.title-stage" &&
        (item.payload as { state: string }).state === "failed",
    );
    expect(failed).toHaveLength(4);
    for (const item of failed) {
      const failure = (item.payload as { failure: { kind: string; detail: string } }).failure;
      expect(failure.kind).toBe("provider");
      expect(failure.detail.length).toBeLessThanOrEqual(500);
      expect(failure.detail).not.toContain("private-secret");
      expect(failure.detail).not.toContain("example.test");
    }
  });
});
