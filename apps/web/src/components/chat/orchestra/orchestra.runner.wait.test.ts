import { ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { makeState, makeThread } from "~/stores/main/main.store.test.helpers";
import { useStore } from "~/stores/main";

import { waitForThreadCompletion } from "./orchestra.runner";

const THREAD_ID = ThreadId.makeUnsafe("orchestra-thread");
const TURN_ID = TurnId.makeUnsafe("assignment-turn");
const REQUESTED_AT = "2026-07-13T19:44:08.908Z";
const COMPLETED_AT = "2026-07-13T19:44:20.494Z";

function setThread(overrides: Parameters<typeof makeThread>[0]) {
  useStore.setState(
    makeState(
      makeThread({
        id: THREAD_ID,
        ...overrides,
      }),
    ),
  );
}

function session(
  orchestrationStatus: "ready" | "running" | "stopped" | "error",
  activeTurnId?: TurnId,
) {
  return {
    provider: "codex" as const,
    status: orchestrationStatus === "stopped" ? ("closed" as const) : orchestrationStatus,
    ...(activeTurnId !== undefined ? { activeTurnId } : {}),
    createdAt: REQUESTED_AT,
    updatedAt: REQUESTED_AT,
    orchestrationStatus,
  };
}

function assignmentTurn(state: "running" | "completed" | "error" | "interrupted") {
  return {
    turnId: TURN_ID,
    state,
    requestedAt: REQUESTED_AT,
    startedAt: REQUESTED_AT,
    completedAt: state === "running" ? null : COMPLETED_AT,
    assistantMessageId: null,
  };
}

describe("waitForThreadCompletion", () => {
  it("ignores a ready session until the assignment turn starts and settles", async () => {
    setThread({ session: session("ready"), latestTurn: null });
    const onResolved = vi.fn();
    const completion = waitForThreadCompletion(THREAD_ID, 1_000).then(onResolved);

    await Promise.resolve();
    expect(onResolved).not.toHaveBeenCalled();

    setThread({
      session: session("running", TURN_ID),
      latestTurn: assignmentTurn("running"),
    });
    await Promise.resolve();
    expect(onResolved).not.toHaveBeenCalled();

    setThread({
      session: session("ready"),
      latestTurn: assignmentTurn("completed"),
    });

    await completion;
    expect(onResolved).toHaveBeenCalledOnce();
  });

  it.each(["error", "interrupted"] as const)("rejects an %s assignment turn", async (state) => {
    setThread({
      session: session("ready"),
      latestTurn: assignmentTurn(state),
    });

    await expect(waitForThreadCompletion(THREAD_ID, 1_000)).rejects.toThrow(
      `Assignment turn ${state}.`,
    );
  });

  it("rejects when the thread stops before its assignment starts", async () => {
    setThread({ session: session("stopped"), latestTurn: null });

    await expect(waitForThreadCompletion(THREAD_ID, 1_000)).rejects.toThrow(
      "Thread stopped before the assignment turn started.",
    );
  });
});
