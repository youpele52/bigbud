import { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  requireCrossProjectConfirmation,
  type ThreadCoordinationDeps,
} from "./ThreadCoordinationConfirmation.ts";
import {
  makeTestCoordination,
  messageEvent,
  threadAttachment,
  turnStartEvent,
} from "./ThreadCoordinationConfirmation.test.helpers.ts";

const caller = ThreadId.makeUnsafe("caller-a1");
const target = "target-b1";
const project = { id: ProjectId.makeUnsafe("project-b"), title: "Billing", targetIsRemote: false };

const gate = (coordination: ThreadCoordinationDeps, referenced = target) =>
  Effect.runPromise(
    requireCrossProjectConfirmation({
      coordination,
      callerThreadId: caller,
      project,
      referencesTarget: (threadId) => threadId === referenced,
    }),
  );

const setup = () => {
  const test = makeTestCoordination();
  const userAsks = (attachments = [threadAttachment(target)]) => {
    const sequence = test.log.nextSequence();
    const commandId = `client-submit-${sequence}`;
    test.log.push(
      messageEvent({
        threadId: caller,
        sequence,
        text: "tell the attached thread to say hi 5 times",
        attachments,
        commandId,
      }),
      turnStartEvent({
        threadId: caller,
        sequence: test.log.nextSequence(),
        messageId: `message-${sequence}`,
        commandId,
      }),
    );
  };
  return { ...test, userAsks };
};

describe("implicit approval in the cross-project gate", () => {
  it("allows every call of the request with no challenge issued and no grant recorded", async () => {
    const { coordination, grants, userAsks } = setup();
    userAsks();
    for (let call = 0; call < 5; call += 1) {
      expect((await gate(coordination)).kind).toBe("allowed");
    }
    expect(Option.isNone(await Effect.runPromise(grants.getChallenge(caller, project.id)))).toBe(
      true,
    );
    expect(await Effect.runPromise(grants.listIssuedChallenges(caller))).toEqual([]);
    expect(await Effect.runPromise(grants.hasGrant(caller, project.id))).toBe(false);
  });

  it("leaves a pending challenge alone and does not grant it", async () => {
    const { coordination, grants, userAsks } = setup();
    userAsks([]);
    const pending = await gate(coordination);
    if (pending.kind !== "confirmation_required") throw new Error("expected a challenge");
    userAsks();
    expect((await gate(coordination)).kind).toBe("allowed");
    const challenge = await Effect.runPromise(grants.getChallenge(caller, project.id));
    expect(Option.getOrUndefined(challenge)?.code).toBe(pending.result.code);
    expect(await Effect.runPromise(grants.hasGrant(caller, project.id))).toBe(false);
  });

  it("asks when the request attaches a different thread or nothing", async () => {
    const attachedOther = setup();
    attachedOther.userAsks();
    expect((await gate(attachedOther.coordination, "another-thread")).kind).toBe(
      "confirmation_required",
    );
    const nothing = setup();
    nothing.userAsks([]);
    expect((await gate(nothing.coordination)).kind).toBe("confirmation_required");
  });

  it("falls back to the question flow when the reader is missing or fails", async () => {
    const { grants, log, userAsks } = setup();
    userAsks();
    const proofReader = {
      readThreadProofEventsAfter: log.reader.readThreadProofEventsAfter!,
      readThreadMaxSequence: log.reader.readThreadMaxSequence!,
    };
    expect((await gate({ grants, eventStore: proofReader })).kind).toBe("confirmation_required");
    const failing: ThreadCoordinationDeps = {
      grants,
      eventStore: {
        ...proofReader,
        readThreadRecentUserTurnEvents: () =>
          Effect.fail(new PersistenceSqlError({ operation: "test", detail: "boom" })),
      },
    };
    expect((await gate(failing)).kind).toBe("confirmation_required");
  });

  it("is off when the caller gives no target reference", async () => {
    const { coordination, userAsks } = setup();
    userAsks();
    const access = await Effect.runPromise(
      requireCrossProjectConfirmation({ coordination, callerThreadId: caller, project }),
    );
    expect(access.kind).toBe("confirmation_required");
  });
});
