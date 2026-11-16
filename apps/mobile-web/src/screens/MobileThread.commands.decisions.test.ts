import type { StoredMobileSession } from "../lib/mobileSession";
import { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import {
  ThreadId,
  type ClientOrchestrationCommand,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMobileCommandDeliveryController } from "../lib/mobileCommandDelivery";
import { createMobileCommandDeliveryState } from "../lib/mobileCommandDelivery.logic";
import {
  createMobileComposerDraft,
  makeMobileComposerDraftIdentity,
  readMobileComposerDraft,
  writeMobileComposerDraft,
} from "../lib/mobileComposerDraft";
import type { MobilePendingUserInput } from "../lib/mobileModels";
import { createMobileThreadCommands } from "./MobileThread.commands";
import { toPersistedDecision } from "./MobileThread.state";

const threadId = ThreadId.makeUnsafe("thread-decisions");
const identity = makeMobileComposerDraftIdentity({
  backendBaseUrl: "https://desk.example",
  sessionId: "session-1",
  threadId,
});
const pendingUserInput = {
  requestId: "request-input-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  questions: [
    {
      id: "q1",
      header: "Pick",
      question: "Which one?",
      options: [{ label: "A", description: "" }],
    },
  ],
} as unknown as MobilePendingUserInput;

type Outcome = { status: "accepted" } | { status: "unknown" } | "offline";

function makeClient(outcome: Outcome, dispatch: (command: ClientOrchestrationCommand) => unknown) {
  return {
    dispatchCommand: vi.fn(async (command: ClientOrchestrationCommand) => dispatch(command)),
    getMobileCommandOutcome: vi.fn(async () => {
      if (outcome === "offline") throw new Error("socket closed");
      return outcome;
    }),
  };
}

/** One page lifetime: commands over a decision controller persisted like the state hook does. */
function openPage(
  client: ReturnType<typeof makeClient>,
  sessionScope: StoredMobileSession["scope"] = "thread-control",
) {
  const restored = readMobileComposerDraft(identity).draft?.decisionSubmitted ?? null;
  const decisionDelivery = createMobileCommandDeliveryController({
    deadlineMs: 1_000,
    initialState: createMobileCommandDeliveryState(restored),
    onStateChange: (state) => {
      const draft =
        readMobileComposerDraft(identity).draft ?? createMobileComposerDraft({ threadId });
      writeMobileComposerDraft(identity, {
        ...draft,
        decisionSubmitted: toPersistedDecision(state),
      });
    },
  });
  const delivery = createMobileCommandDeliveryController({ deadlineMs: 1_000 });
  const setAnswers = vi.fn();
  const setQuestionIndex = vi.fn();
  const commands = () =>
    createMobileThreadCommands({
      actionsAvailable: true,
      sessionScope,
      activePendingUserInput: pendingUserInput,
      activeUserInputAnswers: { q1: { selectedOptionLabels: ["A"] } },
      activeUserInputQuestionIndex: 0,
      client: client as never,
      clearNewThread: () => undefined,
      clearSubmittedIfRevision: () => undefined,
      decisionDelivery,
      delivery,
      draftThread: null,
      isDraft: false,
      project: undefined,
      prompt: "",
      recovery: null,
      refetchSnapshot: async () => undefined,
      refetchThread: async () => undefined,
      revision: 1,
      selectedModelSelection: { provider: "claudeAgent", model: "sonnet" },
      setIsRespondingToUserInput: () => undefined,
      setPendingModelSelection: () => undefined,
      setUserInputAnswersByRequestId: setAnswers,
      setUserInputQuestionIndexByRequestId: setQuestionIndex,
      thread: {
        id: threadId,
        modelSelection: { provider: "claudeAgent", model: "sonnet" },
      } as unknown as OrchestrationThread,
      threadId,
    });
  return { commands, decisionDelivery, delivery, setAnswers, setQuestionIndex };
}

const DECISIONS = [
  [
    "approval",
    "thread.approval.respond",
    (page: ReturnType<typeof openPage>) =>
      page.commands().respondToApproval("request-approval-1" as never, "accept" as never),
  ],
  [
    "answer",
    "thread.user-input.respond",
    (page: ReturnType<typeof openPage>) => page.commands().sendPrompt(),
  ],
  [
    "interrupt",
    "thread.turn.interrupt",
    (page: ReturnType<typeof openPage>) => page.commands().interruptTurn(),
  ],
] as const;

function createSessionStorageMock() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  };
}

describe.each(DECISIONS)("mobile %s delivery across a reload", (_name, type, decide) => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", createSessionStorageMock());
  });

  for (const scope of ["read-only", "approve-only"] as const) {
    it(`${scope} gates this decision before dispatch`, async () => {
      const client = makeClient({ status: "accepted" }, () => ({ sequence: 1 }));
      const page = openPage(client, scope);
      await decide(page);
      expect(client.dispatchCommand).toHaveBeenCalledTimes(
        scope === "approve-only" && type === "thread.approval.respond" ? 1 : 0,
      );
      expect(client.getMobileCommandOutcome).not.toHaveBeenCalled();
    });
  }
  it("does not look up or resend an explicit permission rejection", async () => {
    const client = makeClient({ status: "unknown" }, () => {
      throw new OrchestrationDispatchCommandError({
        message: "Scope denied",
        code: "unauthorized",
      });
    });
    const page = openPage(client);
    await decide(page);
    expect(page.decisionDelivery.getState().status).toBe("rejected");
    expect(page.commands().resendDecisionDelivery).toBeUndefined();
    expect(client.getMobileCommandOutcome).not.toHaveBeenCalled();
  });

  it("restores a lost acknowledgement with the same ID and resends only that ID", async () => {
    // First page: the dispatch is lost and the outcome check cannot reach the host.
    const first = openPage(makeClient("offline", () => Promise.reject(new Error("ack lost"))));
    await decide(first);
    const lost = first.decisionDelivery.getState();
    expect(lost.status).toBe("uncertain");
    expect(lost.operation?.command.type).toBe(type);
    const commandId = lost.operation?.command.commandId;
    // The composer send is not blocked by an unsettled decision.
    expect(first.delivery.getState().status).toBe("idle");

    // Reload: the same operation comes back from storage, still uncertain.
    const resendClient = makeClient({ status: "unknown" }, () => ({ sequence: 7 }));
    const second = openPage(resendClient);
    expect(second.decisionDelivery.getState().status).toBe("uncertain");
    expect(second.decisionDelivery.getState().operation?.command.commandId).toBe(commandId);
    expect(second.commands().resendDecisionDelivery).toBeUndefined();

    // The check finds no record; only then is a resend offered, with the same ID.
    await second.commands().checkDecisionDelivery();
    expect(resendClient.getMobileCommandOutcome).toHaveBeenCalledWith({ commandId, threadId });
    await second.commands().resendDecisionDelivery?.();
    expect(resendClient.dispatchCommand).toHaveBeenCalledOnce();
    expect(resendClient.dispatchCommand.mock.calls[0]?.[0]?.commandId).toBe(commandId);
    expect(second.decisionDelivery.getState().status).toBe("accepted");
    if (type === "thread.user-input.respond") {
      expect(second.setAnswers).toHaveBeenCalled();
      expect(second.setQuestionIndex).toHaveBeenCalled();
      expect(second.setAnswers.mock.calls[0]![0]({ "request-input-1": {}, other: {} })).toEqual({
        other: {},
      });
    }
    // Settled decisions are dropped from storage.
    expect(readMobileComposerDraft(identity).draft?.decisionSubmitted).toBeNull();
  });

  it("does not check a new ID or mutate the old outcome when a decision is unsettled", async () => {
    const client = makeClient("offline", () => Promise.reject(new Error("ack lost")));
    const page = openPage(client);
    await page.commands().respondToApproval("first-request" as never, "accept");
    const before = page.decisionDelivery.getState();
    client.getMobileCommandOutcome.mockClear();
    await decide(page);
    expect(client.dispatchCommand).toHaveBeenCalledOnce();
    expect(client.getMobileCommandOutcome).not.toHaveBeenCalled();
    expect(page.decisionDelivery.getState()).toBe(before);
    expect(page.decisionDelivery.getState().outcomeUnknown).toBeUndefined();
  });

  it("settles from the server's record without dispatching again", async () => {
    const first = openPage(makeClient("offline", () => Promise.reject(new Error("ack lost"))));
    await decide(first);
    const acceptedClient = makeClient({ status: "accepted" }, () => ({ sequence: 1 }));
    const second = openPage(acceptedClient);
    await second.commands().checkDecisionDelivery();
    expect(second.decisionDelivery.getState().status).toBe("accepted");
    if (type === "thread.user-input.respond") {
      expect(second.setAnswers).toHaveBeenCalled();
      expect(second.setQuestionIndex).toHaveBeenCalled();
      expect(second.setAnswers.mock.calls[0]![0]({ "request-input-1": {}, other: {} })).toEqual({
        other: {},
      });
    }
    expect(acceptedClient.dispatchCommand).not.toHaveBeenCalled();
  });
});
