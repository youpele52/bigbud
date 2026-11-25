import "../../../../index.css";
import { ApprovalRequestId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { PendingUserInput } from "../../../../logic/session/session.logic";
import { resetWsConnectionStateForTests } from "../../../../rpc/wsConnectionState";
import { useComposerDraftStore } from "../../../../stores/composer/composer.store";
import {
  makeImage,
  resetComposerDraftStore,
} from "../../../../stores/composer/composer.store.test.utils";
import { createSendControl, installSendApi } from "../ChatView.sendTurn.browser-helpers";
import { recentId, resetProjectGateStore } from "../ThreadProjectGate.test-helpers";
import { ChatViewComposerHeader } from "./ChatViewComposerHeader";
import { PendingAnswerFlowHarness } from "./PendingUserInputPanel.browser-helpers";

const request: PendingUserInput = {
  requestId: ApprovalRequestId.makeUnsafe("panel-request"),
  createdAt: "2026-11-13T00:00:00.000Z",
  questions: [
    {
      id: "deploy",
      header: "Deploy target",
      question: "Where should this deploy?",
      options: [
        { label: "Staging", description: "Safe first" },
        { label: "Production", description: "Live users" },
      ],
      multiSelect: false,
    },
    {
      id: "areas",
      header: "Areas",
      question: "Which areas should change?",
      options: [
        { label: "Server", description: "Backend" },
        { label: "Web", description: "Frontend" },
        { label: "Docs", description: "Guides" },
      ],
      multiSelect: true,
    },
  ],
};

let mounted: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  localStorage.clear();
  resetProjectGateStore();
  resetComposerDraftStore();
  resetWsConnectionStateForTests();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});
const draft = () => useComposerDraftStore.getState().draftsByThreadId[recentId];

it("queues chat and its attachments without answering, then submits the two independent answers", async () => {
  await installSendApi();
  useComposerDraftStore.getState().setPrompt(recentId, "Keep this chat separate");
  useComposerDraftStore
    .getState()
    .addImage(recentId, makeImage({ id: "chat-shot", previewUrl: "data:image/png;base64,AQ==" }));
  const respond = vi.fn();
  const submit = vi.fn(async () => "queued" as const);
  mounted = await render(
    <PendingAnswerFlowHarness
      threadId={recentId}
      input={request}
      control={createSendControl()}
      onRespond={respond}
      overrides={{ submitQueuedComposerPrompt: submit }}
    />,
  );
  await expect.element(page.getByRole("textbox", { name: "Answer text" })).toHaveValue("");
  await page.getByText("Staging", { exact: true }).click();
  await page.getByRole("textbox", { name: "Answer text" }).fill("behind the flag");
  await page.getByRole("button", { name: "Queue message" }).click();
  await vi.waitFor(() =>
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        text: "Keep this chat separate",
        attachments: [expect.objectContaining({ type: "image" })],
      }),
    ),
  );
  expect(respond).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("textbox", { name: "Answer text" }))
    .toHaveValue("behind the flag");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect.element(page.getByText("2 of 2")).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Answer text" })).toHaveValue("");
  const answer = page.getByRole("button", { name: "Submit answer" });
  await expect.element(answer).toBeDisabled();
  await page.getByText("Server", { exact: true }).click();
  await page.getByText("Docs", { exact: true }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("A newer chat draft");
  await answer.click();
  expect(respond).toHaveBeenCalledExactlyOnceWith(request.requestId, {
    deploy: "Staging\nbehind the flag",
    areas: "Server, Docs",
  });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(draft()?.prompt).toBe("A newer chat draft");
});

it("renders the question panel in the compact composer, wrapping chips at narrow widths", async () => {
  const progress = {
    questionIndex: 0,
    activeQuestion: request.questions[1]!,
    activeDraft: undefined,
  };
  mounted = await render(
    <div style={{ width: 240 }}>
      <ChatViewComposerHeader
        threadId="compact-thread"
        compact
        thread={
          {
            activePendingUserInput: request,
            activePendingProgress: progress,
            activePendingApproval: { requestId: "approval" },
          } as never
        }
        interactions={
          {
            pendingAction: null,
            pendingUserInputHandlers: {
              onToggleActivePendingUserInputOption: vi.fn(),
              setActivePendingUserInputQuestionIndex: vi.fn(),
            },
          } as never
        }
      />
    </div>,
  );
  const panel = document.querySelector<HTMLElement>("[data-pending-user-input-panel]")!;
  await expect.element(page.getByText("Needs you")).toBeVisible();
  await expect.element(page.getByRole("checkbox", { name: /Server/ })).toBeInTheDocument();
  // Compact keeps its old contract: no approval panel or prompt queue, only the question.
  expect(document.body.textContent).not.toContain("approval");
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
});
