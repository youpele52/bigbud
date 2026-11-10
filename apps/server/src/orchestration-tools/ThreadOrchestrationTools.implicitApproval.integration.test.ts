import { CommandId, MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { makeQueuedPromptFlushCommand } from "../orchestration/QueuedPromptFlush.logic.ts";
import { makeThreadCoordinationGrants } from "./Layers/ThreadCoordinationGrants.ts";
import { threadAttachment } from "./ThreadCoordinationConfirmation.test.helpers.ts";
import { moveThreadViaOrchestration } from "./ThreadOrchestrationTools.organization.ts";
import { renameThreadViaOrchestration } from "./ThreadOrchestrationTools.rename.ts";
import { sendThreadMessageViaOrchestration } from "./ThreadOrchestrationTools.sendMessage.ts";
import {
  callerId,
  otherProjectId,
  targetId,
  unrelatedId,
  withDormantThreads,
} from "./ThreadOrchestrationTools.restart.fixture.ts";
import { resetThreadTitleLockForTests } from "./ThreadTitleLock.ts";

const at = "2026-11-10T12:00:00.000Z";

/** The composer's submit: the user's text with the target thread attached. */
const userSubmit = (input: {
  readonly id: string;
  readonly delivery: "auto" | "queue";
  readonly attach?: ThreadId;
}) =>
  ({
    type: "thread.message.submit",
    commandId: CommandId.makeUnsafe(`client-${input.id}`),
    threadId: callerId,
    message: {
      messageId: MessageId.makeUnsafe(input.id),
      text: "tell the attached thread to say hi 5 times",
      attachments: input.attach ? [threadAttachment(input.attach, "Target")] : [],
    },
    delivery: input.delivery,
    createdAt: at,
  }) as OrchestrationCommand;

type Fixture = Parameters<Parameters<typeof withDormantThreads>[1]>[0];

const tools = ({ engine, runtime, repository, eventStore }: Fixture) => {
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
        message: "hi",
        delivery: "queue",
        invocationId,
      }),
    );
  const submit = (command: OrchestrationCommand) => runtime.runPromise(engine.dispatch(command));
  return { grants, coordination, send, submit };
};

it("sends five times on the user's own request that attached the target, with no prompt", async () => {
  await withDormantThreads({ foreign: true }, async (fixture) => {
    const { grants, send, submit } = tools(fixture);
    await submit(userSubmit({ id: "ask-direct", delivery: "auto", attach: targetId }));
    for (let index = 0; index < 5; index += 1) {
      expect(await send(`hi-${index}`)).toMatchObject({ delivery: "queued" });
    }
    expect(await Effect.runPromise(grants.listIssuedChallenges(callerId))).toEqual([]);
    expect(await Effect.runPromise(grants.hasGrant(callerId, otherProjectId))).toBe(false);
  });
});

it("accepts the same request typed while the agent was busy and delivered by a queue flush", async () => {
  await withDormantThreads({ foreign: true }, async (fixture) => {
    const { send, submit } = tools(fixture);
    await submit(userSubmit({ id: "ask-queued", delivery: "queue", attach: targetId }));
    // Still only queued: the agent has not received it, so nothing is implied yet.
    expect(await send("hi-early")).toMatchObject({ status: "confirmation_required" });
    const flush = makeQueuedPromptFlushCommand({
      threadId: callerId,
      readModel: await fixture.runtime.runPromise(fixture.engine.getReadModel()),
      createdAt: at,
    });
    if (flush === null) throw new Error("expected a queue flush");
    expect(String(flush.commandId)).toMatch(/^queue-flush:/);
    await submit(flush);
    expect(await send("hi-flushed")).toMatchObject({ delivery: "queued" });
  });
});

it("asks when the user's request attached nothing or a different thread", async () => {
  await withDormantThreads({ foreign: true }, async (fixture) => {
    const { send, submit } = tools(fixture);
    await submit(userSubmit({ id: "ask-bare", delivery: "auto" }));
    expect(await send("hi-bare")).toMatchObject({ status: "confirmation_required" });
  });
  await withDormantThreads({ foreign: true }, async (fixture) => {
    const { send, submit } = tools(fixture);
    await submit(userSubmit({ id: "ask-other", delivery: "auto", attach: unrelatedId }));
    expect(await send("hi-other")).toMatchObject({ status: "confirmation_required" });
  });
});

it("renames and moves the attached target on the user's request", async () => {
  await withDormantThreads({ foreign: true }, async (fixture) => {
    resetThreadTitleLockForTests();
    const { coordination, submit } = tools(fixture);
    await submit(userSubmit({ id: "ask-organize", delivery: "auto", attach: targetId }));
    const base = {
      orchestrationEngine: fixture.engine,
      threadDelegationRepository: fixture.repository,
      coordination,
      threadId: callerId,
      targetThreadId: targetId,
    };
    await expect(
      fixture.runtime.runPromise(renameThreadViaOrchestration({ ...base, title: "Say hi" })),
    ).resolves.toMatchObject({ title: "Say hi", threadId: targetId });
    await expect(
      fixture.runtime.runPromise(
        moveThreadViaOrchestration({ ...base, state: "done", invocationId: "move-1" }),
      ),
    ).resolves.toMatchObject({ threadId: targetId, changed: true });
  });
});
