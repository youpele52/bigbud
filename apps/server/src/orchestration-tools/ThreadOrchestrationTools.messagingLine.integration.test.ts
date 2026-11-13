import { CommandId, MessageId, type ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { makeThreadCoordinationGrants } from "./Layers/ThreadCoordinationGrants.ts";
import { threadAttachment } from "./ThreadCoordinationConfirmation.test.helpers.ts";
import { isThreadCoordinationRefusal } from "./ThreadCoordinationConfirmation.result.ts";
import { askQuestion, respond } from "./ThreadOrchestrationTools.crossProject.test.helpers.ts";
import { renameThreadViaOrchestration } from "./ThreadOrchestrationTools.rename.ts";
import { sendThreadMessageViaOrchestration } from "./ThreadOrchestrationTools.sendMessage.ts";
import {
  callerId,
  projectId,
  targetId,
  unrelatedId,
  withDormantThreads,
} from "./ThreadOrchestrationTools.restart.fixture.ts";
import { resetThreadTitleLockForTests } from "./ThreadTitleLock.ts";
import { SEND_THREAD_MESSAGE_TOOL_DESCRIPTION } from "./threadOrchestrationBridge.shared.ts";

/**
 * A two-way messaging line: once a message from thread A (project A) to thread B (project B) is
 * allowed, B can message A back without a new confirmation. Only messages, only those two
 * threads, and only until restart (a fresh grants service).
 */
type Fixture = Parameters<Parameters<typeof withDormantThreads>[1]>[0];

function toolsFor({ engine, runtime, repository, eventStore }: Fixture) {
  const grants = Effect.runSync(makeThreadCoordinationGrants());
  const coordination = { grants, eventStore };
  const deps = {
    orchestrationEngine: engine,
    threadDelegationRepository: repository,
    coordination,
  };
  const dispatch = (command: OrchestrationCommand) => runtime.runPromise(engine.dispatch(command));
  return {
    grants,
    dispatch,
    send: (from: ThreadId, to: ThreadId, invocationId: string) =>
      runtime.runPromise(
        sendThreadMessageViaOrchestration({
          ...deps,
          callerThreadId: from,
          threadId: to,
          message: `hello from ${from}`,
          delivery: "queue",
          invocationId,
        }),
      ),
    rename: (from: ThreadId, to: ThreadId) =>
      runtime.runPromise(
        renameThreadViaOrchestration({
          ...deps,
          threadId: from,
          targetThreadId: to,
          title: "Renamed",
        }),
      ),
    /** The user answers the caller's confirmation question in bigbud's question panel. */
    answer: async (threadId: ThreadId, question: string, choice: "Allow" | "Deny") => {
      await dispatch(askQuestion(threadId, `card-${choice}`, question, "user-input.requested"));
      await dispatch(respond(threadId, `card-${choice}`, { [question]: choice }));
    },
  };
}

const questionOf = (result: unknown) => {
  if (!isThreadCoordinationRefusal(result) || result.status !== "confirmation_required") {
    throw new Error(`expected confirmation_required, got ${JSON.stringify(result)}`);
  }
  return result.question;
};

it("opens a two-way messaging line between exactly the two threads after an Allow", async () => {
  await withDormantThreads({ foreign: true }, async (fixture) => {
    resetThreadTitleLockForTests();
    const tools = toolsFor(fixture);
    const question = questionOf(await tools.send(callerId, targetId, "a-to-b"));
    expect(await tools.send(targetId, callerId, "b-to-a-early")).toMatchObject({
      status: "confirmation_required",
    });
    await tools.answer(callerId, question, "Allow");
    expect(await tools.send(callerId, targetId, "a-to-b")).toMatchObject({ delivery: "queued" });

    // The reply needs no confirmation, and neither does the next message either way.
    expect(await tools.send(targetId, callerId, "b-to-a")).toMatchObject({ delivery: "queued" });
    expect(await tools.send(callerId, targetId, "a-to-b-2")).toMatchObject({ delivery: "queued" });

    // The line is two threads, not two projects, and messages only.
    expect(await tools.send(targetId, unrelatedId, "b-to-other-a")).toMatchObject({
      status: "confirmation_required",
    });
    expect(await tools.rename(targetId, callerId)).toMatchObject({
      status: "confirmation_required",
    });
    expect(await Effect.runPromise(tools.grants.hasGrant(targetId, projectId))).toBe(false);

    // Lines live in memory: after a restart (a fresh grants service) the reply asks again.
    expect(await toolsFor(fixture).send(targetId, callerId, "b-to-a-restart")).toMatchObject({
      status: "confirmation_required",
    });
  });
});

it("opens no line when the user denies the message", async () => {
  await withDormantThreads({ foreign: true }, async (fixture) => {
    const tools = toolsFor(fixture);
    const question = questionOf(await tools.send(callerId, targetId, "a-to-b"));
    await tools.answer(callerId, question, "Deny");
    expect(await tools.send(callerId, targetId, "a-to-b")).toMatchObject({
      status: "confirmation_denied",
    });
    expect(await tools.send(targetId, callerId, "b-to-a")).toMatchObject({
      status: "confirmation_required",
    });
  });
});

it("opens a line from the user's own attached request, which records no project grant", async () => {
  await withDormantThreads({ foreign: true }, async (fixture) => {
    const tools = toolsFor(fixture);
    await tools.dispatch({
      type: "thread.message.submit",
      commandId: CommandId.makeUnsafe("client-attached-request"),
      threadId: callerId,
      message: {
        messageId: MessageId.makeUnsafe("attached-request"),
        text: "tell the attached thread to say hi",
        attachments: [threadAttachment(targetId, "Target")],
      },
      // Delivered to the agent (not just queued), so it counts as the user's request.
      delivery: "auto",
      createdAt: "2026-11-10T12:00:00.000Z",
    } as OrchestrationCommand);
    expect(await tools.send(callerId, targetId, "a-to-b")).toMatchObject({ delivery: "queued" });
    expect(await tools.send(targetId, callerId, "b-to-a")).toMatchObject({ delivery: "queued" });
  });
});

it("lets a child created in another project always message the thread that created it", async () => {
  await withDormantThreads({ foreign: true, delegated: true }, async (fixture) => {
    resetThreadTitleLockForTests();
    const tools = toolsFor(fixture);
    expect(await tools.send(targetId, callerId, "child-to-parent")).toMatchObject({
      delivery: "queued",
    });
    // Only its creator, and only messages.
    expect(await tools.send(targetId, unrelatedId, "child-to-other")).toMatchObject({
      status: "confirmation_required",
    });
    expect(await tools.rename(targetId, callerId)).toMatchObject({
      status: "confirmation_required",
    });
  });
});

it("tells agents about the line in the send_thread_message description", () => {
  expect(SEND_THREAD_MESSAGE_TOOL_DESCRIPTION).toContain(
    "those two threads can message each other in both directions without asking until bigbud restarts",
  );
});
