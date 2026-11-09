import { useRef } from "react";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { render } from "vitest-browser-react";
import { usePlanFollowUp } from "./ChatView.planFollowUp";
import type { UsePlanHandlersInput, UsePlanHandlersResult } from "./ChatView.planHandlers.logic";
import {
  SendHarness,
  createSendControl,
  deferred,
  installSendApi,
} from "./ChatView.sendTurn.browser-helpers";
import { recentId, otherId, resetProjectGateStore } from "./ThreadProjectGate.test-helpers";
import { resetComposerDraftStore } from "../../../stores/composer/composer.store.test.utils";
import { useComposerDraftStore } from "../../../stores/composer";
import { useStore } from "../../../stores/main";
import { resetWsConnectionStateForTests } from "../../../rpc/wsConnectionState";

interface PlanControl {
  send: UsePlanHandlersResult["onSubmitPlanFollowUp"];
  input: UsePlanHandlersInput | null;
  ui: { optimistic: Mock; reset: Mock; open: Mock };
}
const control = (): PlanControl => ({
  send: async () => false,
  input: null,
  ui: { optimistic: vi.fn(), reset: vi.fn(), open: vi.fn() },
});
function PlanHarness({ threadId, state }: { threadId: ThreadId; state: PlanControl }) {
  const thread = useStore((store) => store.threads.find((entry) => entry.id === threadId));
  const sendInFlightRef = useRef(false);
  const shouldAutoScrollRef = useRef(false);
  const planCardDismissedForTurnRef = useRef<string | null>(null);
  const planCardOpenOnNextThreadRef = useRef(false);
  const input: UsePlanHandlersInput = {
    activeThread: thread,
    activeProject: undefined,
    activeProposedPlan: { id: "plan-1", planMarkdown: "# Plan" },
    isServerThread: true,
    isSendBusy: false,
    isConnecting: false,
    sendInFlightRef,
    shouldAutoScrollRef,
    planCardDismissedForTurnRef,
    planCardOpenOnNextThreadRef,
    selectedProvider: "codex",
    selectedModel: "gpt-5.5",
    selectedProviderModels: [],
    selectedPromptEffort: null,
    selectedModelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    setOptimisticUserMessages: state.ui.optimistic,
    setPlanCardOpen: state.ui.open,
    setThreadError: (id, error) => useStore.getState().setError(id, error),
    setComposerDraftInteractionMode: useComposerDraftStore.getState().setInteractionMode,
    beginLocalDispatch: () => {},
    resetLocalDispatch: state.ui.reset,
    forceStickToBottom: () => {},
    persistThreadSettingsForNextTurn: async () => {},
  };
  state.input = input;
  state.send = usePlanFollowUp(input);
  return <span>Plan for {threadId}</span>;
}

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
const followUp = { text: "Implement the plan", interactionMode: "default" as const };

it("reuses the plan follow-up command and message IDs after an unknown acknowledgment", async () => {
  const api = await installSendApi();
  api.dispatchCommand.mockRejectedValueOnce(new Error("lost acknowledgment"));
  const state = control();
  mounted = await render(<PlanHarness threadId={recentId} state={state} />);
  expect(await state.send(followUp)).toBe(false);
  const first = api.dispatchCommand.mock.calls[0]![0];
  expect(useStore.getState().threads.find((thread) => thread.id === recentId)?.error).toContain(
    "without duplicating",
  );
  expect(await state.send(followUp)).toBe(true);
  expect(api.getCommandOutcome).toHaveBeenCalledWith({ commandId: first.commandId });
  expect(state.ui.optimistic.mock.lastCall![0]([])).toEqual([
    expect.objectContaining({ id: "message" in first ? first.message.messageId : undefined }),
  ]);
  expect(api.dispatchCommand.mock.calls[1]![0]).toMatchObject({
    commandId: first.commandId,
    message: { messageId: "message" in first ? first.message.messageId : undefined },
  });
});

it.each([false, true])(
  "reconciles an accepted plan retry without redispatch, preserving changedDraft=%s",
  async (changedDraft) => {
    const api = await installSendApi();
    api.dispatchCommand.mockRejectedValueOnce(new Error("lost acknowledgment"));
    const state = control();
    const sending = createSendControl();
    mounted = await render(
      <>
        <PlanHarness threadId={recentId} state={state} />
        <SendHarness
          threadId={recentId}
          control={sending}
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
            onSubmitPlanFollowUp: (input) => state.send(input),
          }}
        />
      </>,
    );
    await sending.onSend();
    const first = api.dispatchCommand.mock.calls[0]![0];
    expect(useComposerDraftStore.getState().draftsByThreadId[recentId]?.prompt).toBe(
      "Original follow-up",
    );
    if (changedDraft) {
      useComposerDraftStore.getState().setPrompt(recentId, "Keep my different follow-up");
      await vi.waitFor(() =>
        expect(sending.input!.promptRef.current).toBe("Keep my different follow-up"),
      );
    }
    api.getCommandOutcome.mockResolvedValue({
      commandId: first.commandId,
      status: "accepted",
      serverEpoch: "test-server",
      canonicalRevision: 11,
      aggregateKind: "thread",
      aggregateId: recentId,
      resultSequence: 11,
      acceptedAt: "2026-11-09T00:00:00.000Z",
    });
    await sending.onSend();
    expect(api.dispatchCommand).toHaveBeenCalledOnce();
    expect(useComposerDraftStore.getState().draftsByThreadId[recentId]?.prompt ?? "").toBe(
      changedDraft ? "Keep my different follow-up" : "",
    );
  },
);

it("does not reset a newly navigated plan surface when the old follow-up fails", async () => {
  const api = await installSendApi();
  const acknowledgment = deferred<{ sequence: number }>();
  api.dispatchCommand.mockReturnValue(acknowledgment.promise);
  const state = control();
  mounted = await render(<PlanHarness threadId={recentId} state={state} />);
  const sending = state.send(followUp);
  await vi.waitFor(() => expect(api.dispatchCommand).toHaveBeenCalledOnce());
  await mounted.rerender(<PlanHarness threadId={otherId} state={state} />);
  state.input!.sendInFlightRef.current = true;
  vi.clearAllMocks();
  acknowledgment.reject(new Error("lost acknowledgment"));
  expect(await sending).toBe(false);
  expect(state.input!.sendInFlightRef.current).toBe(true);
  expect(state.ui.optimistic).not.toHaveBeenCalled();
  expect(state.ui.reset).not.toHaveBeenCalled();
  expect(state.ui.open).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().draftsByThreadId[otherId]?.prompt).toBe(
    "Other thread draft",
  );
});
