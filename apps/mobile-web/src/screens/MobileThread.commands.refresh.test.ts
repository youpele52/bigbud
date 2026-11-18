import type { StoredMobileSession } from "../lib/mobileSession";
import { ThreadId, type OrchestrationThread } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { createMobileThreadCommands } from "./MobileThread.commands";
import { createMobileCommandDeliveryController } from "../lib/mobileCommandDelivery";
import type { MobileRecoveryFreshness } from "../logic/mobileRecovery.types";

const lost = async () => {
  throw new Error("response lost");
};

const threadId = ThreadId.makeUnsafe("thread-refresh");

function makeThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId: "project-1" as OrchestrationThread["projectId"],
    title: "Existing thread",
    modelSelection: { provider: "claudeAgent", model: "sonnet" },
    runtimeMode: "full-access",
    interactionMode: "default",
    latestTurn: null,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
  } as unknown as OrchestrationThread;
}

function commandsWith(
  freshness: MobileRecoveryFreshness,
  dispatch: () => Promise<unknown>,
  delivery = createMobileCommandDeliveryController({ deadlineMs: 1_000 }),
  isDraft = false,
  sessionScope: StoredMobileSession["scope"] = "thread-control",
) {
  const refresh = vi.fn();
  const recovery = { getState: () => ({ freshness }), refresh } as never;
  const commands = createMobileThreadCommands({
    actionsAvailable: true,
    sessionScope,
    activePendingUserInput: null,
    activeUserInputAnswers: {},
    activeUserInputQuestionIndex: 0,
    client: { dispatchCommand: dispatch } as never,
    clearNewThread: () => undefined,
    clearSubmittedIfRevision: () => undefined,
    delivery,
    draftThread: isDraft
      ? {
          threadId,
          projectId: makeThread().projectId,
          createdAt: "2026-01-01T00:00:00Z",
          branch: null,
          worktreePath: null,
          runtimeMode: "full-access",
          interactionMode: "default",
          modelSelection: null,
        }
      : null,
    isDraft,
    project: isDraft
      ? ({
          id: makeThread().projectId,
          title: "Project",
          defaultModelSelection: makeThread().modelSelection,
        } as never)
      : undefined,
    prompt: "Hello",
    recovery,
    refetchSnapshot: async () => undefined,
    refetchThread: async () => undefined,
    revision: 1,
    selectedModelSelection: { provider: "claudeAgent", model: "sonnet" },
    setIsRespondingToUserInput: () => undefined,
    setPendingModelSelection: () => undefined,
    setUserInputAnswersByRequestId: () => undefined,
    setUserInputQuestionIndexByRequestId: () => undefined,
    thread: makeThread(),
    threadId,
  });
  return { commands, refresh };
}

describe("mobile command refresh after delivery", () => {
  it("relies on the caught-up live stream instead of re-downloading the baseline", async () => {
    const { commands, refresh } = commandsWith("current", async () => ({ sequence: 1 }));
    await commands.sendPrompt();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes accepted draft creation before clearing the local draft", async () => {
    const dispatch = vi.fn(async () => ({ sequence: 1 }));
    const { commands, refresh } = commandsWith("current", dispatch, undefined, true);
    await commands.sendPrompt();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.turn.start" }));
    expect(refresh).toHaveBeenCalledWith(threadId);
  });

  it.each(["stale", "refreshing", "legacy", "unavailable"] as const)(
    "still refreshes after a command while recovery is %s",
    async (freshness) => {
      const { commands, refresh } = commandsWith(freshness, async () => ({ sequence: 1 }));
      await commands.sendPrompt();
      expect(refresh).toHaveBeenCalledWith(threadId);
    },
  );
});

describe("mobile resend offer", () => {
  it("offers a resend only after a delivery check found no server record", async () => {
    const delivery = createMobileCommandDeliveryController({ deadlineMs: 1_000 });
    expect(commandsWith("current", lost, delivery).commands.resendDelivery).toBeUndefined();
    await commandsWith("current", lost, delivery).commands.sendPrompt();
    expect(delivery.getState().status).toBe("uncertain");
    expect(commandsWith("current", lost, delivery).commands.resendDelivery).toBeUndefined();
    await delivery.reconcile(async () => ({ status: "unknown" }));
    expect(commandsWith("current", lost, delivery).commands.resendDelivery).toBeTypeOf("function");
  });
});

for (const scope of ["read-only", "approve-only"] as const) {
  for (const isDraft of [false, true]) {
    it(`${scope} cannot submit ${isDraft ? "a new" : "an existing"} thread message`, async () => {
      const dispatch = vi.fn();
      const { commands } = commandsWith("current", dispatch, undefined, isDraft, scope);
      await commands.sendPrompt();
      expect(dispatch).not.toHaveBeenCalled();
    });
  }
}
