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

it("answers two questions in one send, then queues the image with a label naming both", async () => {
  await installSendApi();
  useComposerDraftStore.getState().setPrompt(recentId, "");
  const respond = vi.fn(async () => {});
  const submit = vi.fn(async () => "queued" as const);
  const control = createSendControl();
  mounted = await render(
    <PendingAnswerFlowHarness
      threadId={recentId}
      input={request}
      control={control}
      overrides={{ onRespondToUserInput: respond, submitQueuedComposerPrompt: submit }}
    />,
  );
  await expect.element(page.getByText("1 of 2")).toBeVisible();
  await page.getByText("Staging", { exact: true }).click();
  await expect.element(page.getByRole("radio", { name: /Staging/ })).toBeChecked();
  await page.getByRole("textbox", { name: "Message" }).fill("behind the flag");
  // The real primary action advances on non-final questions; the editor swaps to question 2.
  await page.getByRole("button", { name: "Next question" }).last().click();
  await expect.element(page.getByText("2 of 2")).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  const submitAnswers = page.getByRole("button", { name: "Submit answers" });
  await expect.element(submitAnswers).toBeDisabled();
  await page.getByText("Server", { exact: true }).click();
  await page.getByText("Docs", { exact: true }).click();
  useComposerDraftStore
    .getState()
    .addImage(recentId, makeImage({ id: "answer-shot", previewUrl: "data:image/png;base64,AQ==" }));
  await submitAnswers.click();
  await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(respond).toHaveBeenCalledExactlyOnceWith(request.requestId, {
    deploy: "Staging\nbehind the flag",
    areas: "Server, Docs",
  });
  expect(respond.mock.invocationCallOrder[0]).toBeLessThan(submit.mock.invocationCallOrder[0]!);
  expect(submit).toHaveBeenCalledWith({
    text: [
      "The attached files are part of my answer to: Deploy target",
      "The attached files are part of my answer to: Areas",
    ].join("\n"),
    attachments: [expect.objectContaining({ type: "image" })],
  });
  await vi.waitFor(() => expect(draft()?.images ?? []).toEqual([]));
});

it("cannot send a required question with nothing selected and nothing typed", async () => {
  await installSendApi();
  useComposerDraftStore.getState().setPrompt(recentId, "");
  const respond = vi.fn(async () => {});
  const control = createSendControl();
  const single = { ...request, questions: [request.questions[0]!] };
  mounted = await render(
    <PendingAnswerFlowHarness
      threadId={recentId}
      input={single}
      control={control}
      overrides={{ onRespondToUserInput: respond }}
    />,
  );
  await expect.element(page.getByRole("button", { name: "Submit answer" })).toBeDisabled();
  await control.onSend();
  expect(respond).not.toHaveBeenCalled();
  await page.getByText("Production", { exact: true }).click();
  await page.getByRole("button", { name: "Submit answer" }).click();
  await vi.waitFor(() =>
    expect(respond).toHaveBeenCalledExactlyOnceWith(single.requestId, { deploy: "Production" }),
  );
});

it("treats an unsent draft as the arriving question's context so it can be sent at once", async () => {
  await installSendApi();
  useComposerDraftStore.getState().setPrompt(recentId, "Use the canary cluster");
  const respond = vi.fn(async () => {});
  const control = createSendControl();
  const single = { ...request, questions: [request.questions[0]!] };
  mounted = await render(
    <PendingAnswerFlowHarness
      threadId={recentId}
      input={single}
      control={control}
      overrides={{ onRespondToUserInput: respond }}
    />,
  );
  await page.getByRole("button", { name: "Submit answer" }).click();
  await vi.waitFor(() =>
    expect(respond).toHaveBeenCalledExactlyOnceWith(single.requestId, {
      deploy: "Use the canary cluster",
    }),
  );
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
