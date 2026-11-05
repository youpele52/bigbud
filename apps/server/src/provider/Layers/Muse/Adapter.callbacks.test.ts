import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { makeMuseHostCallbacks } from "./Adapter.startSession.callbacks.ts";
import { mapMuseTurnNotification } from "./Adapter.stream.turns.ts";
import { mapUserInputRequested } from "./Adapter.questions.ts";
import {
  approvalParams,
  deferred,
  makeMuseTestHost,
  makeMuseTestState,
  threadId,
} from "./Adapter.failures.test.helpers.ts";

describe("Muse defensive asynchronous callbacks", () => {
  it("fails a buffered request even if replay is awaiting a native command during startup failure", async () => {
    const host = makeMuseTestHost();
    const state = makeMuseTestState(host);
    const entered = deferred<void>();
    const ack = deferred<Record<string, unknown>>();
    host.transport.command = async () => {
      entered.resolve();
      return ack.promise;
    };
    const callbacks = makeMuseHostCallbacks({
      threadId,
      admissions: undefined,
      getState: () => state,
      emit: () => undefined,
    });
    const receipt = callbacks.onServerRequest({
      method: "userInput/request",
      params: { userInputId: "u", questions: [null] },
    });
    const rejection = expect(receipt).rejects.toThrow("startup cancelled");
    const activation = callbacks.activate();
    const activationRejected = expect(activation).rejects.toThrow("startup cancelled");
    await entered.promise;
    callbacks.fail(new Error("startup cancelled"));
    await rejection;
    ack.resolve({ commandId: "cmd-1", status: "accepted", userInputId: "u" });
    await activationRejected;
  });
  it.each([42, null, {}, { message: 42 }, { message: null }])(
    "malformed terminal error cannot escape the callback or become success: %j",
    async (error) => {
      const state = makeMuseTestState();
      const events: Array<ProviderRuntimeEvent> = [];
      const callbacks = makeMuseHostCallbacks({
        threadId,
        admissions: undefined,
        getState: () => state,
        emit: (event) => events.push(event),
      });
      await callbacks.activate();
      expect(() =>
        callbacks.onNotification({
          method: "turn/completed",
          params: { turnId: "turn", terminal: "completed", error },
        }),
      ).not.toThrow();
      expect(events.at(-1)).toMatchObject({ type: "turn.completed", payload: { state: "failed" } });
    },
  );
  it("rejects malformed IDs before state mutation and ignores closed/mismatched sessions", async () => {
    const state = makeMuseTestState();
    const events: Array<ProviderRuntimeEvent> = [];
    const callbacks = makeMuseHostCallbacks({
      threadId,
      admissions: undefined,
      getState: () => state,
      emit: (event) => events.push(event),
    });
    await callbacks.activate();
    callbacks.onNotification({ method: "turn/started", params: { turnId: 42 } });
    expect(state.activeTurnId).toBeUndefined();
    expect(events.at(-1)?.type).toBe("runtime.error");
    events.length = 0;
    callbacks.onNotification({
      method: "turn/started",
      params: { turnId: "turn", sessionId: "wrong" },
    });
    state.closed = true;
    callbacks.onNotification({
      method: "turn/completed",
      params: { turnId: "turn", terminal: "completed" },
    });
    expect(events).toEqual([]);
    expect(state.lastSettledTurnId).toBeUndefined();
    expect(mapMuseTurnNotification(threadId, { method: "turn/completed", params: {} })).toEqual([]);
  });
  it.each([
    { questions: [null] },
    { questions: [42] },
    { questions: [{}] },
    { questions: [{ id: "q", header: "h", question: "?", options: [null] }] },
    { questions: [{ id: "q", header: "h", question: "?", options: [{ label: 42 }] }] },
  ])("validates every question and option: %j", ({ questions }) => {
    expect(() => mapUserInputRequested(threadId, { userInputId: "u", questions })).not.toThrow();
    expect(mapUserInputRequested(threadId, { userInputId: "u", questions })).toBeUndefined();
  });
  it("does not acknowledge malformed approval requests as handled", async () => {
    const state = makeMuseTestState();
    const callbacks = makeMuseHostCallbacks({
      threadId,
      admissions: undefined,
      getState: () => state,
      emit: () => undefined,
    });
    await callbacks.activate();
    await expect(
      callbacks.onServerRequest({ method: "approval/request", params: { approvalId: "broken" } }),
    ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
    expect(state.pendingApprovals.size).toBe(0);
  });
  it("retains unsupported user input when explicit native cancellation fails", async () => {
    const host = makeMuseTestHost();
    const state = makeMuseTestState(host);
    const events: Array<string> = [];
    host.transport.command = async () => {
      throw new Error("lost cancellation acknowledgement");
    };
    const callbacks = makeMuseHostCallbacks({
      threadId,
      admissions: undefined,
      getState: () => state,
      emit: (event) => events.push(event.type),
    });
    await callbacks.activate();
    await expect(
      callbacks.onServerRequest({
        method: "userInput/request",
        params: { userInputId: "u", questions: [null] },
      }),
    ).rejects.toThrow("lost cancellation");
    expect(state.pendingUserInputs.has("u")).toBe(true);
    expect(events).toContain("runtime.error");
  });
  it("fails buffered requests when startup fails instead of returning an empty receipt", async () => {
    const callbacks = makeMuseHostCallbacks({
      threadId,
      admissions: undefined,
      getState: () => undefined,
      emit: () => undefined,
    });
    const pending = callbacks.onServerRequest({
      method: "approval/request",
      params: approvalParams(),
    });
    const rejection = expect(pending).rejects.toThrow("startup cancelled");
    callbacks.fail(new Error("startup cancelled"));
    await rejection;
  });
  it("bounds startup callbacks and fails explicitly on overflow", async () => {
    const callbacks = makeMuseHostCallbacks({
      threadId,
      admissions: undefined,
      getState: () => undefined,
      emit: () => undefined,
    });
    for (let i = 0; i < 129; i++)
      callbacks.onNotification({ method: "turn/started", params: { turnId: `t${i}` } });
    await expect(callbacks.activate()).rejects.toMatchObject({
      _tag: "ProviderAdapterValidationError",
    });
  });
});
