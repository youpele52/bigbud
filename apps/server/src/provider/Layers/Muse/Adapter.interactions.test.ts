import { Effect, Fiber, Stream } from "effect";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { makeMuseHostCallbacks } from "./Adapter.startSession.callbacks.ts";
import {
  approvalParams,
  makeMuseTestHost,
  makeMuseTestState,
  startInput,
  threadId,
} from "./Adapter.failures.test.helpers.ts";

const questions = [{ id: "q", header: "Choice", question: "Which?", options: [{ label: "one" }] }];

describe("Muse interactive command acknowledgements", () => {
  it("stamps command-driven request resolutions with the owning session epoch", async () => {
    const host = makeMuseTestHost();
    const events: Array<ProviderRuntimeEvent> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* host.adapter();
        const subscriber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ).pipe(Effect.forkDetach);
        yield* Effect.sleep(5);
        yield* adapter.startSession({ ...startInput, sessionEpoch: 7 });
        yield* Effect.promise(() =>
          host.request({ method: "approval/request", params: approvalParams(host.sessionId()) }),
        );
        yield* adapter.respondToRequest(threadId, "approval:0" as never, "accept");
        yield* Effect.promise(() =>
          host.request({
            method: "userInput/request",
            params: { sessionId: host.sessionId(), userInputId: "u", questions },
          }),
        );
        yield* adapter.respondToUserInput(threadId, "u" as never, { q: "one" });
        yield* Effect.sleep(5);
        expect(
          events.filter(
            (event) => event.type === "request.resolved" || event.type === "user-input.resolved",
          ),
        ).toMatchObject([
          { type: "request.resolved", sessionEpoch: 7 },
          { type: "user-input.resolved", sessionEpoch: 7 },
        ]);
        yield* adapter.stopAll();
        yield* Fiber.interrupt(subscriber);
      }),
    );
  });
  it.each(["approval/decide", "userInput/answer"] as const)(
    "retains pending %s on uncertain or malformed ack, retires after exact ack",
    async (targetMethod) => {
      const host = makeMuseTestHost();
      const original = host.transport.command;
      let outcome = "lost";
      host.transport.command = async (method, params, cid) => {
        if (method === targetMethod) {
          if (outcome === "lost") throw { detail: "pipe lost" };
          if (outcome === "malformed") return {};
        }
        return original(method, params, cid);
      };
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* host.adapter();
          yield* adapter.startSession(startInput);
          yield* Effect.promise(() =>
            targetMethod === "approval/decide"
              ? host.request({
                  method: "approval/request",
                  params: approvalParams(host.sessionId()),
                })
              : host.request({
                  method: "userInput/request",
                  params: { sessionId: host.sessionId(), userInputId: "u", questions },
                }),
          );
          const respond = () =>
            targetMethod === "approval/decide"
              ? adapter.respondToRequest(threadId, "approval:0" as never, "accept")
              : adapter.respondToUserInput(threadId, "u" as never, { q: "one" });
          for (const step of ["lost", "malformed"]) {
            outcome = step;
            const result = yield* respond().pipe(Effect.result);
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure")
              expect(result.failure.failureClass).toBe("unsafe-to-replay");
          }
          outcome = "accepted";
          yield* respond();
          expect((yield* respond().pipe(Effect.result))._tag).toBe("Failure");
          expect(host.calls.filter((call) => call.method === targetMethod)).toHaveLength(1);
          yield* adapter.stopAll();
        }),
      );
    },
  );
  it("authoritative native resolutions retire pending requests and emit canonical resolution once", async () => {
    const state = makeMuseTestState();
    const events: Array<string> = [];
    const callbacks = makeMuseHostCallbacks({
      threadId,
      admissions: undefined,
      getState: () => state,
      emit: (event) => events.push(event.type),
    });
    await callbacks.activate();
    await callbacks.onServerRequest({ method: "approval/request", params: approvalParams() });
    await callbacks.onServerRequest({
      method: "userInput/request",
      params: { sessionId: "native", userInputId: "u", questions },
    });
    for (let i = 0; i < 2; i++) {
      callbacks.onNotification({
        method: "approval/resolved",
        params: { sessionId: "native", approvalId: "approval", decision: "approved" },
      });
      callbacks.onNotification({
        method: "userInput/settled",
        params: {
          sessionId: "native",
          userInputId: "u",
          outcome: "answered",
          answers: [{ questionId: "q", selectedLabel: "one" }],
        },
      });
    }
    expect(events).toEqual([
      "request.opened",
      "user-input.requested",
      "request.resolved",
      "user-input.resolved",
    ]);
    expect(state.pendingApprovals.size).toBe(0);
    expect(state.pendingUserInputs.size).toBe(0);
  });
  it("malformed Stop acknowledgement cannot claim cancellation or mutate the running turn", async () => {
    const host = makeMuseTestHost();
    const original = host.transport.command;
    host.transport.command = async (method, params, cid) =>
      method === "turn/cancel" ? {} : original(method, params, cid);
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* host.adapter();
        yield* adapter.startSession(startInput);
        const ack = yield* adapter.sendTurn({ threadId, input: "work" });
        const result = yield* adapter.interruptTurn(threadId, ack.turnId).pipe(Effect.result);
        if (result._tag === "Success") throw new Error("malformed ack succeeded");
        expect(result.failure.failureClass).toBe("unsafe-to-replay");
        expect((yield* adapter.listSessions())[0]?.activeTurnId).toBe(ack.turnId);
        yield* adapter.stopAll();
      }),
    );
  });
});
