import { CommandId, EventId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { titleFixture } from "./ProviderCommandReactorSessionOps.title.fixture.ts";
import { TITLE_OWNERSHIP_ACTIVITY } from "../../orchestration-tools/TerminalThreadTitle.ts";
import { resetThreadTitleLockForTests } from "../../orchestration-tools/ThreadTitleLock.ts";

describe("durable title ownership before generation", () => {
  it.each(["terminal", "manual"] as const)(
    "does not pay for chat title generation on a %s-owned title after restart",
    async (source) => {
      const harness = titleFixture();
      await Effect.runPromise(
        harness.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`owner:${source}`),
          threadId: harness.thread.id,
          activity: {
            id: EventId.makeUnsafe("owner"),
            kind: TITLE_OWNERSHIP_ACTIVITY,
            tone: "info",
            summary: "Naming owner",
            payload: { source },
            turnId: null,
            createdAt: harness.thread.createdAt,
          },
          createdAt: harness.thread.createdAt,
        }),
      );
      resetThreadTitleLockForTests();
      await Effect.runPromise(harness.run());
      await Effect.runPromise(harness.run(true));
      expect(harness.generate).not.toHaveBeenCalled();
      expect(harness.thread.title).toBe("New thread");
    },
  );
});
