import {
  ApprovalRequestId,
  CommandId,
  EventId,
  MessageId,
  type ThreadId,
} from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { makeThreadCoordinationGrants } from "./Layers/ThreadCoordinationGrants.ts";
import { isThreadCoordinationRefusal } from "./ThreadCoordinationConfirmation.result.ts";
import { renameThreadViaOrchestration } from "./ThreadOrchestrationTools.rename.ts";
import { sendThreadMessageViaOrchestration } from "./ThreadOrchestrationTools.sendMessage.ts";
import {
  callerId,
  targetId,
  withDormantThreads,
} from "./ThreadOrchestrationTools.restart.fixture.ts";
import { resetThreadTitleLockForTests } from "./ThreadTitleLock.ts";

const at = "2026-11-10T12:00:00.000Z";

const askQuestion = (threadId: ThreadId, requestId: string, question: string, kind: string) =>
  ({
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe(`provider:activity:${requestId}:${kind}`),
    threadId,
    activity: {
      id: EventId.makeUnsafe(`activity-${requestId}-${kind}`),
      tone: "info",
      kind,
      summary: kind,
      payload:
        kind === "user-input.requested"
          ? {
              requestId,
              questions: [
                {
                  id: question,
                  header: "Confirm",
                  question,
                  options: [
                    { label: "Allow", description: "Allow it" },
                    { label: "Deny", description: "Deny it" },
                  ],
                },
              ],
            }
          : { requestId, answers: { [question]: "Allow" } },
      turnId: null,
      createdAt: at,
    },
    createdAt: at,
  }) as OrchestrationCommand;

const respond = (threadId: ThreadId, requestId: string, answers: Record<string, unknown>) =>
  ({
    type: "thread.user-input.respond",
    commandId: CommandId.makeUnsafe(`client-respond-${requestId}`),
    threadId,
    requestId: ApprovalRequestId.makeUnsafe(requestId),
    answers,
    createdAt: at,
  }) as OrchestrationCommand;

it("grants a cross-project pair only from a recorded client answer in SQLite", async () => {
  await withDormantThreads(
    { foreign: true },
    async ({ engine, runtime, repository, eventStore }) => {
      resetThreadTitleLockForTests();
      const grants = Effect.runSync(makeThreadCoordinationGrants());
      const coordination = { grants, eventStore };
      const send = (invocationId: string) =>
        runtime.runPromise(
          sendThreadMessageViaOrchestration({
            orchestrationEngine: engine,
            threadDelegationRepository: repository,
            coordination,
            callerThreadId: callerId,
            threadId: targetId,
            message: "please run the release checklist",
            delivery: "queue",
            invocationId,
          }),
        );

      const challenge = await send("cross-1");
      if (!isThreadCoordinationRefusal(challenge) || challenge.status !== "confirmation_required") {
        throw new Error("expected a confirmation challenge");
      }
      // A provider-reported resolution is never proof, even with "Allow".
      await runtime.runPromise(
        engine.dispatch(askQuestion(callerId, "auto", challenge.question, "user-input.requested")),
      );
      await runtime.runPromise(
        engine.dispatch(askQuestion(callerId, "auto", challenge.question, "user-input.resolved")),
      );
      expect(await send("cross-1")).toMatchObject({
        status: "confirmation_required",
        code: challenge.code,
      });

      await runtime.runPromise(
        engine.dispatch(askQuestion(callerId, "card", challenge.question, "user-input.requested")),
      );
      await runtime.runPromise(
        engine.dispatch(respond(callerId, "card", { [challenge.question]: "Allow" })),
      );
      const modesOf = async () => {
        const thread = (await runtime.runPromise(engine.getReadModel())).threads.find(
          (candidate) => candidate.id === targetId,
        );
        return { runtimeMode: thread?.runtimeMode, interactionMode: thread?.interactionMode };
      };
      const modesBefore = await modesOf();
      expect(await send("cross-1")).toMatchObject({ delivery: "queued" });
      // A cross-project message grants the target nothing: its own modes and approvals stay.
      expect(await modesOf()).toEqual(modesBefore);

      // One grant covers any write by this caller into the project, with no new prompt.
      await expect(
        runtime.runPromise(
          renameThreadViaOrchestration({
            orchestrationEngine: engine,
            threadDelegationRepository: repository,
            coordination,
            threadId: callerId,
            targetThreadId: targetId,
            title: "Release checklist",
          }),
        ),
      ).resolves.toMatchObject({ title: "Release checklist", threadId: targetId });
    },
  );
});

it("returns confirmation_denied for a recorded client Deny", async () => {
  await withDormantThreads(
    { foreign: true },
    async ({ engine, runtime, repository, eventStore }) => {
      const coordination = { grants: Effect.runSync(makeThreadCoordinationGrants()), eventStore };
      const send = () =>
        runtime.runPromise(
          sendThreadMessageViaOrchestration({
            orchestrationEngine: engine,
            threadDelegationRepository: repository,
            coordination,
            callerThreadId: callerId,
            threadId: targetId,
            message: "denied work",
            delivery: "queue",
            invocationId: "denied-1",
          }),
        );
      const challenge = await send();
      if (!isThreadCoordinationRefusal(challenge) || challenge.status !== "confirmation_required") {
        throw new Error("expected a confirmation challenge");
      }
      await runtime.runPromise(
        engine.dispatch(askQuestion(callerId, "no", challenge.question, "user-input.requested")),
      );
      await runtime.runPromise(
        engine.dispatch(respond(callerId, "no", { [challenge.question]: "Deny" })),
      );
      expect(await send()).toMatchObject({ status: "confirmation_denied" });
      expect(
        (await runtime.runPromise(engine.getReadModel())).threads.find((t) => t.id === targetId)
          ?.queuedPrompts ?? [],
      ).toEqual([]);
    },
  );
});

it("grants from a plain chat reply the user typed after the challenge, in SQLite", async () => {
  await withDormantThreads(
    { foreign: true },
    async ({ engine, runtime, repository, eventStore }) => {
      const coordination = { grants: Effect.runSync(makeThreadCoordinationGrants()), eventStore };
      const send = () =>
        runtime.runPromise(
          sendThreadMessageViaOrchestration({
            orchestrationEngine: engine,
            threadDelegationRepository: repository,
            coordination,
            callerThreadId: callerId,
            threadId: targetId,
            message: "Say hi",
            delivery: "queue",
            invocationId: "chat-1",
          }),
        );
      expect(await send()).toMatchObject({ status: "confirmation_required" });
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.message.submit",
          commandId: CommandId.makeUnsafe("client-chat-approval"),
          threadId: callerId,
          message: {
            messageId: MessageId.makeUnsafe("chat-approval"),
            text: "I approve. Please send Say hi to the attached thread.",
          },
          delivery: "queue",
          createdAt: at,
        }),
      );
      expect(await send()).toMatchObject({ delivery: "queued" });
    },
  );
});
