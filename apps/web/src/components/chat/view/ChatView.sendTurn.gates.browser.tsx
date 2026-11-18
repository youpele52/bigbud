import { ApprovalRequestId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  SendHarness,
  createSendControl,
  deferred,
  installSendApi,
} from "./ChatView.sendTurn.browser-helpers";
import { recentId, resetProjectGateStore } from "./ThreadProjectGate.test-helpers";
import { useComposerDraftStore } from "../../../stores/composer";
import {
  makeImage,
  resetComposerDraftStore,
} from "../../../stores/composer/composer.store.test.utils";
import { useStore } from "../../../stores/main";
import { resetWsConnectionStateForTests } from "../../../rpc/wsConnectionState";

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

it("restores text and attachments when the running-turn queue refuses the prompt", async () => {
  const api = await installSendApi();
  useComposerDraftStore
    .getState()
    .addImage(
      recentId,
      makeImage({ id: "queued-image", previewUrl: "data:image/png;base64,AQ==" }),
    );
  const submit = vi.fn(async () => "full" as const);
  const control = createSendControl();
  mounted = await render(
    <SendHarness
      threadId={recentId}
      control={control}
      overrides={{
        isSendBusy: true,
        shouldQueuePrompt: () => true,
        submitQueuedComposerPrompt: submit,
      }}
    />,
  );
  await control.onSend();
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      text: "Original follow-up",
      attachments: [expect.objectContaining({ type: "image" })],
    }),
  );
  expect(api.dispatchCommand).not.toHaveBeenCalled();
  expect(draft()).toMatchObject({ prompt: "Original follow-up", images: [{ id: "queued-image" }] });
});

it("routes structured answers before ordinary dispatch and preserves edits made while the answer is pending", async () => {
  const api = await installSendApi();
  const answer = deferred<void>();
  const respond = vi.fn(() => answer.promise);
  const requestId = ApprovalRequestId.makeUnsafe("question-1");
  const control = createSendControl();
  mounted = await render(
    <SendHarness
      threadId={recentId}
      control={control}
      overrides={{
        isSendBusy: true,
        isOpencodePendingUserInputMode: true,
        activePendingUserInputRequestId: requestId,
        onRespondToUserInput: respond,
      }}
    />,
  );
  const sending = control.onSend();
  await vi.waitFor(() =>
    expect(respond).toHaveBeenCalledWith(requestId, { [requestId]: "Original follow-up" }),
  );
  useComposerDraftStore.getState().setPrompt(recentId, "Keep this newer answer");
  await vi.waitFor(() => expect(control.input!.promptRef.current).toBe("Keep this newer answer"));
  answer.resolve();
  await sending;
  expect(api.dispatchCommand).not.toHaveBeenCalled();
  expect(draft()?.prompt).toBe("Keep this newer answer");
});

it.each([false, true])("only clears a plan follow-up after accepted=%s", async (accepted) => {
  const api = await installSendApi();
  const submit = vi.fn(async () => accepted);
  const control = createSendControl();
  mounted = await render(
    <SendHarness
      threadId={recentId}
      control={control}
      overrides={{
        showPlanFollowUpPrompt: true,
        activeProposedPlan: {
          id: "plan-1",
          planMarkdown: "# Plan",
          turnId: null,
          createdAt: "2026-11-09T00:00:00.000Z",
          updatedAt: "2026-11-09T00:00:00.000Z",
          implementedAt: null,
          implementationThreadId: null,
        },
        onSubmitPlanFollowUp: submit,
      }}
    />,
  );
  await control.onSend();
  expect(submit).toHaveBeenCalledOnce();
  expect(draft()?.prompt ?? "").toBe(accepted ? "" : "Original follow-up");
  expect(api.dispatchCommand).not.toHaveBeenCalled();
});

it("reports an unloaded shell project without dropping the shell draft", async () => {
  const api = await installSendApi();
  const control = createSendControl();
  mounted = await render(
    <SendHarness
      threadId={recentId}
      control={control}
      overrides={{ isComposerShellMode: true, activeProject: undefined }}
    />,
  );
  await control.onSend();
  expect(api.dispatchCommand).not.toHaveBeenCalled();
  expect(draft()?.prompt).toBe("Original follow-up");
  expect(useStore.getState().threads.find((thread) => thread.id === recentId)?.error).toContain(
    "project is not loaded",
  );
});
