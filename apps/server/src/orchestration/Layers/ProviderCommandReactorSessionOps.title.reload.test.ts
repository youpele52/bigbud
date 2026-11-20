import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
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
  state: "started" | "failed" | "uncertain" | "completed",
  protectedUncertainty = false,
) =>
  Effect.runPromise(
    recordTitleStage(f.services, f.thread, 1, state, undefined, protectedUncertainty),
  );

/** Legacy evidence remains readable after replacing the old paid four-stage pipeline. */
describe("legacy title evidence through production-sorted projection reloads", () => {
  afterEach(resetThreadTitleLockForTests);

  it.each(["completed", "failed"] as const)(
    "retains definitive %s settlement despite sorted starts",
    async (state) => {
      const f = titleFixture();
      await stage(f, "started");
      await stage(f, state);
      f.reload();
      expect(readTitleStage(f.thread, 1)?.state).toBe(state);
      expect(hasUnresolvedTitleGeneration(f.thread)).toBe(false);
    },
  );

  it("recognizes historical false uncertainty only with the same stage's definitive settlement", async () => {
    const f = titleFixture();
    await stage(f, "started");
    await stage(f, "failed");
    await stage(f, "uncertain");
    await status(f, "uncertain");
    f.reload();
    expect(hasUnresolvedTitleGeneration(f.thread)).toBe(false);
    expect(f.thread.activities.some((item) => item.kind === "text-generation.uncertain")).toBe(
      true,
    );
  });

  it("preserves actual unresolved starts across repeated reloads without paid replay", async () => {
    const f = titleFixture();
    await stage(f, "started");
    for (let index = 0; index < 2; index++) {
      f.reload();
      expect(hasUnresolvedTitleGeneration(f.thread)).toBe(true);
      await Effect.runPromise(f.run());
    }
    expect(readTitleStage(f.thread, 1)?.state).toBe("started");
    expect(f.generate).not.toHaveBeenCalled();
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
      f.reload();
      expect(hasUnresolvedTitleGeneration(f.thread)).toBe(true);
      await Effect.runPromise(f.run());
      expect(f.generate).not.toHaveBeenCalled();
    },
  );
});
