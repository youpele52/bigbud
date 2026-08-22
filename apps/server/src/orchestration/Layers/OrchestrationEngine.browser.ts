import type { BrowserAction, OrchestrationReadModel, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { BrowserManagerShape } from "../../browser/Services/BrowserManager.ts";
import type { VisibleBrowserControlShape } from "../../browser/Services/VisibleBrowserControl.ts";
import { browserViaOrchestration } from "../../orchestration-tools/ThreadBrowserTools.ts";

export const executeBrowserAction = Effect.fn("executeBrowserAction")(function* (input: {
  readonly browser: BrowserManagerShape;
  readonly readModel: () => OrchestrationReadModel;
  readonly threadId: ThreadId;
  readonly action: BrowserAction;
  readonly visibleBrowser: VisibleBrowserControlShape;
}) {
  const requestedTarget = input.action.target ?? "auto";
  const tabId =
    requestedTarget === "auto" && input.action.tabId === undefined
      ? yield* input.visibleBrowser.resolveThreadLease(input.threadId)
      : input.action.tabId;
  if (requestedTarget === "visible" || (requestedTarget === "auto" && tabId)) {
    const thread = input.readModel().threads.find((candidate) => candidate.id === input.threadId);
    const turnId =
      thread?.session?.status === "running"
        ? (thread.session.activeTurnId ??
          (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null))
        : null;
    if (!turnId) {
      return yield* Effect.fail(new Error("The visible browser requires an active agent turn."));
    }
    return yield* input.visibleBrowser.execute({
      threadId: input.threadId,
      turnId,
      action: tabId === undefined ? input.action : { ...input.action, tabId },
    });
  }
  return yield* browserViaOrchestration({
    browser: input.browser,
    threadId: input.threadId,
    action: input.action,
  });
});
