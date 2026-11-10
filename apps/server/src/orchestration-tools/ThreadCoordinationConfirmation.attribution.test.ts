import { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  requireCrossProjectConfirmation,
  type ThreadCoordinationDeps,
  type ThreadCoordinationTargetProject,
} from "./ThreadCoordinationConfirmation.ts";
import {
  makeTestCoordination,
  messageEvent,
} from "./ThreadCoordinationConfirmation.test.helpers.ts";

const caller = ThreadId.makeUnsafe("caller-a1");
const projectB = { id: ProjectId.makeUnsafe("project-b"), title: "Billing", targetIsRemote: false };
const projectC = { id: ProjectId.makeUnsafe("project-c"), title: "Catalog", targetIsRemote: false };

const gate = (coordination: ThreadCoordinationDeps, project: ThreadCoordinationTargetProject) =>
  Effect.runPromise(
    requireCrossProjectConfirmation({ coordination, callerThreadId: caller, project }),
  );

const required = (access: Awaited<ReturnType<typeof gate>>) => {
  if (access.kind !== "confirmation_required") throw new Error(`expected required: ${access.kind}`);
  return access.result;
};

/** Real-shaped codes (base32), so a reply can name one. */
const sequentialCodes = () => {
  const codes = ["BB-BBBBBBB2", "BB-CCCCCCC3", "BB-DDDDDDD4", "BB-EEEEEEE5", "BB-FFFFFFF6"];
  let index = 0;
  return () => codes[index++] ?? `BB-ZZZZZZZ${index}`;
};

const setup = () => {
  const test = makeTestCoordination({ generateCode: sequentialCodes() });
  const say = (text: string) =>
    test.log.push(messageEvent({ threadId: caller, sequence: test.log.nextSequence(), text }));
  return { ...test, say };
};

describe("cross-project chat reply attribution", () => {
  it("gives a plain yes only to the most recently issued pending challenge", async () => {
    const { coordination, say } = setup();
    const b = required(await gate(coordination, projectB));
    required(await gate(coordination, projectC));
    say("yes");
    expect((await gate(coordination, projectC)).kind).toBe("allowed");
    // C was resolved before B's retry, so B keeps its code and stays undecided.
    expect(required(await gate(coordination, projectB)).code).toBe(b.code);
    say(`yes ${b.code}`);
    expect((await gate(coordination, projectB)).kind).toBe("allowed");
  });

  it("gives a reply naming a challenge's code only to that challenge", async () => {
    const { coordination, say } = setup();
    const b = required(await gate(coordination, projectB));
    const c = required(await gate(coordination, projectC));
    say(`yes ${b.code}`);
    expect((await gate(coordination, projectB)).kind).toBe("allowed");
    expect(required(await gate(coordination, projectC)).code).toBe(c.code);
  });

  it("re-asks a superseded challenge as the latest, so the next yes reaches it", async () => {
    const { coordination, say } = setup();
    const b = required(await gate(coordination, projectB));
    required(await gate(coordination, projectC));
    say("yes");
    // Retrying B while the newer C is still pending issues B afresh as the latest challenge.
    const reissued = required(await gate(coordination, projectB));
    expect(reissued.code).not.toBe(b.code);
    say(`yes ${b.code}`);
    expect(required(await gate(coordination, projectB)).code).toBe(reissued.code);
    say("yes");
    expect((await gate(coordination, projectB)).kind).toBe("allowed");
    // The first yes, typed while C was the latest, still belongs to C.
    expect((await gate(coordination, projectC)).kind).toBe("allowed");
  });
});

describe("a chat refusal stands", () => {
  it.each([
    ["a later chat yes", "yes"],
    ["later chatter", "thanks"],
  ])("is not undone by %s", async (_name, later) => {
    const { coordination, say } = setup();
    required(await gate(coordination, projectB));
    say("no");
    say(later);
    expect((await gate(coordination, projectB)).kind).toBe("denied");
  });

  it("covers only the request asked about: a new attempt can be approved", async () => {
    const { coordination, say, grants } = setup();
    const first = required(await gate(coordination, projectB));
    say("no");
    expect((await gate(coordination, projectB)).kind).toBe("denied");
    const fresh = required(await gate(coordination, projectB));
    expect(fresh.code).not.toBe(first.code);
    // The old "no" is before the fresh floor, so it cannot deny the new challenge.
    expect(required(await gate(coordination, projectB)).code).toBe(fresh.code);
    say("yes");
    expect((await gate(coordination, projectB)).kind).toBe("allowed");
    expect(await Effect.runPromise(grants.hasGrant(caller, projectB.id))).toBe(true);
  });

  it("does not deny an older pending challenge with a no meant for the newer one", async () => {
    const { coordination, say } = setup();
    const b = required(await gate(coordination, projectB));
    required(await gate(coordination, projectC));
    say("no");
    expect((await gate(coordination, projectC)).kind).toBe("denied");
    expect(required(await gate(coordination, projectB)).code).toBe(b.code);
    say("yes");
    expect((await gate(coordination, projectB)).kind).toBe("allowed");
  });
});
