import { ApprovalRequestId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { PendingUserInput } from "../../../../logic/session/session.logic";
import { derivePendingUserInputProgress } from "../../../../logic/user-input/pending.logic";
import type { ChatViewBaseState } from "./chat-view-base-state.hooks";
import { usePendingUserInputComposerSync } from "./chat-view-effects.pendingInput.hooks";
import type { ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

const request: PendingUserInput = {
  requestId: ApprovalRequestId.makeUnsafe("thread-b-request"),
  createdAt: "2026-11-13T00:00:00.000Z",
  questions: [
    {
      id: "deploy",
      header: "Deploy target",
      question: "Where?",
      options: [{ label: "Staging", description: "Staging" }],
    },
  ],
};

/** ChatView keeps its refs across thread switches, so promptRef may hold the previous thread. */
function Probe({
  prompt,
  staleRef,
  setDrafts,
}: {
  prompt: string;
  staleRef: string;
  setDrafts: () => void;
}) {
  usePendingUserInputComposerSync(
    {
      prompt,
      promptRef: { current: staleRef },
      collapseExpandedComposerCursor: (_text: string, cursor: number) => cursor,
      detectComposerTrigger: () => null,
      setComposerCursor: vi.fn(),
      setComposerHighlightedItemId: vi.fn(),
      setComposerTrigger: vi.fn(),
      setPendingUserInputAnswersByRequestId: setDrafts,
      setPrompt: vi.fn(),
    } as unknown as ChatViewBaseState,
    {
      activePendingUserInput: request,
      activePendingProgress: derivePendingUserInputProgress(request.questions, {}, 0),
    } as unknown as ChatViewThreadDerivedState,
  );
  return null;
}

it("never copies the previous thread's composer text into an arriving question", async () => {
  const setDrafts = vi.fn();
  const screen = await render(<Probe prompt="" staleRef="Thread A draft" setDrafts={setDrafts} />);
  expect(setDrafts).not.toHaveBeenCalled();
  await screen.unmount();
});

it("copies the arriving thread's own unsent draft as the question's context", async () => {
  let drafts: Record<string, Record<string, { customAnswer?: string }>> = {};
  const setDrafts = vi.fn((update: (existing: typeof drafts) => typeof drafts) => {
    drafts = update(drafts);
  });
  const screen = await render(
    <Probe
      prompt="Use the canary cluster"
      staleRef="Thread A draft"
      setDrafts={setDrafts as never}
    />,
  );
  expect(drafts[request.requestId]?.deploy?.customAnswer).toBe("Use the canary cluster");
  await screen.unmount();
});
