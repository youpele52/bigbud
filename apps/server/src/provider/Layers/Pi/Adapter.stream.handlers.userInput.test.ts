import { ApprovalRequestId, type ProviderRuntimeEvent, type ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeRespondToUserInput } from "./Adapter.methods.respondToUserInput.ts";
import { handleExtensionUiRequest } from "./Adapter.stream.handlers.userInput.ts";
import type { ActivePiSession, PiSyntheticEventFn } from "./Adapter.types.ts";

const threadId = "thread-pi-question" as ThreadId;

function setup() {
  const write = vi.fn(async () => {});
  const session = {
    threadId,
    sessionEpoch: 1,
    activeTurnId: undefined,
    runtimeMode: "approval-required",
    turns: [],
    pendingUserInputs: new Map(),
    process: { write },
  } as unknown as ActivePiSession;
  const events: ProviderRuntimeEvent[] = [];
  const emit = (batch: ReadonlyArray<ProviderRuntimeEvent>) =>
    Effect.sync(() => void events.push(...batch));
  const makeSyntheticEvent = ((_thread, _epoch, type, payload, extra) =>
    Effect.succeed({ type, payload, ...extra })) as PiSyntheticEventFn;
  return { write, session, events, emit, makeSyntheticEvent };
}

describe("Pi dialog questions", () => {
  it("renders a select dialog as a question whose options are id-matched to their labels", async () => {
    const { session, events, emit, makeSyntheticEvent } = setup();
    await Effect.runPromise(
      handleExtensionUiRequest({
        emit,
        makeSyntheticEvent,
        runPromise: Effect.runPromise,
        session,
        sessions: new Map([[threadId, session]]),
        message: {
          type: "extension_ui_request",
          id: "dialog-1",
          method: "select",
          title: "Where should this deploy?",
          options: ["Staging", "Production"],
        },
      }),
    );
    expect(events[0]).toMatchObject({
      type: "user-input.requested",
      requestId: "dialog-1",
      payload: {
        questions: [
          {
            question: "Where should this deploy?",
            options: [
              { id: "Staging", label: "Staging" },
              { id: "Production", label: "Production" },
            ],
          },
        ],
      },
    });
  });

  it("answers the dialog with exactly the chosen option", async () => {
    const { write, session, emit, makeSyntheticEvent } = setup();
    await Effect.runPromise(
      handleExtensionUiRequest({
        emit,
        makeSyntheticEvent,
        runPromise: Effect.runPromise,
        session,
        sessions: new Map([[threadId, session]]),
        message: {
          type: "extension_ui_request",
          id: "dialog-2",
          method: "select",
          title: "Pick one",
          options: ["Staging", "Production"],
        },
      }),
    );
    const respond = makeRespondToUserInput({
      requireSession: () => Effect.succeed(session),
      emit,
      makeSyntheticEvent,
    });
    const questionId = session.pendingUserInputs.get("dialog-2")!.question.id;
    await Effect.runPromise(
      respond(threadId, ApprovalRequestId.makeUnsafe("dialog-2"), { [questionId]: "Production" }),
    );
    expect(write).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "dialog-2",
      value: "Production",
    });
  });
});
