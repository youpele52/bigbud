import { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  THREAD_COORDINATION_PROOF_SCAN_CAP,
  requireCrossProjectConfirmation,
  type ThreadCoordinationDeps,
} from "./ThreadCoordinationConfirmation.ts";
import {
  makeTestCoordination,
  messageEvent,
  pushClientAnswer,
  queuedPromptEvent,
  questionEvent,
  responseEvent,
} from "./ThreadCoordinationConfirmation.test.helpers.ts";

const caller = ThreadId.makeUnsafe("caller-a1");
const sibling = ThreadId.makeUnsafe("caller-a2");
const project = { id: ProjectId.makeUnsafe("project-b"), title: "Billing", targetIsRemote: true };

const gate = (coordination: ThreadCoordinationDeps | undefined, callerThreadId = caller) =>
  Effect.runPromise(requireCrossProjectConfirmation({ coordination, callerThreadId, project }));

const requiredCode = (access: Awaited<ReturnType<typeof gate>>) => {
  if (access.kind !== "confirmation_required") throw new Error(`expected required: ${access.kind}`);
  return access.result;
};

describe("requireCrossProjectConfirmation", () => {
  it("fails closed without a grants service or a proof reader", async () => {
    const missing = requiredCode(await gate(undefined));
    expect(missing).toMatchObject({ status: "confirmation_required", targetIsRemote: true });
    expect(missing.instructions).toContain("unavailable");
    const { grants } = makeTestCoordination();
    expect((await gate({ grants })).kind).toBe("confirmation_required");
    await Effect.runPromise(grants.grant(caller, project.id));
    expect((await gate({ grants })).kind).toBe("allowed");
  });

  it("issues a remote-aware challenge, then grants after a client Allow after its floor", async () => {
    const { coordination, log, grants } = makeTestCoordination();
    log.push(messageEvent({ threadId: caller, sequence: log.nextSequence(), text: "hello" }));
    const first = requiredCode(await gate(coordination));
    expect(first.question).toContain('project "Billing" (remote)');
    expect(first.question).toContain(first.code);
    expect(first).toMatchObject({ allowLabel: "Allow", denyLabel: "Deny" });
    expect(first.question).toContain(`(Reference: ${first.code})`);
    expect(first.instructions).toContain("ask the user in chat to reply yes or no");
    expect(first.instructions).toContain("Never ask the user to type the code");
    expect(first.instructions).toContain(
      "Ask about this project on its own, showing exactly the `question` text, which names the project.",
    );
    expect(first.instructions).not.toContain(first.code);
    expect(requiredCode(await gate(coordination)).code).toBe(first.code);

    pushClientAnswer(log, { callerThreadId: caller, question: first.question, answer: "Allow" });
    expect((await gate(coordination)).kind).toBe("allowed");
    expect(await Effect.runPromise(grants.hasGrant(caller, project.id))).toBe(true);

    const spy = vi.spyOn(log.reader, "readThreadProofEventsAfter");
    expect((await gate(coordination)).kind).toBe("allowed");
    expect(spy).not.toHaveBeenCalled();
    expect((await gate(coordination, sibling)).kind).toBe("confirmation_required");
    const projectC = { ...project, id: ProjectId.makeUnsafe("project-c"), title: "Catalog" };
    const otherProject = await Effect.runPromise(
      requireCrossProjectConfirmation({ coordination, callerThreadId: caller, project: projectC }),
    );
    expect(otherProject.kind).toBe("confirmation_required");
  });

  it("returns denied, clears the challenge, and issues a new code next time", async () => {
    const { coordination, log } = makeTestCoordination();
    const first = requiredCode(await gate(coordination));
    pushClientAnswer(log, { callerThreadId: caller, question: first.question, answer: "Deny" });
    const denied = await gate(coordination);
    expect(denied).toMatchObject({ kind: "denied", result: { status: "confirmation_denied" } });
    if (denied.kind !== "denied") throw new Error("expected denied");
    expect(denied.result.instructions).toContain(
      "do not ask about it again unless the user brings it up. A different, later request may ask again.",
    );
    expect(requiredCode(await gate(coordination)).code).not.toBe(first.code);
  });

  it("matches the request id only against a question asked on the caller thread", async () => {
    const { coordination, log } = makeTestCoordination();
    const { question } = requiredCode(await gate(coordination));
    log.push(
      questionEvent({ threadId: sibling, sequence: log.nextSequence(), requestId: "r", question }),
      responseEvent({
        threadId: caller,
        sequence: log.nextSequence(),
        requestId: "r",
        answers: { [question]: "Allow" },
      }),
    );
    expect((await gate(coordination)).kind).toBe("confirmation_required");
  });

  it.each(["allow", "I approve. Please send Say hi to the attached thread."])(
    "grants from the live-test chat reply %j, with no code",
    async (text) => {
      const { coordination, log } = makeTestCoordination();
      requiredCode(await gate(coordination));
      log.push(messageEvent({ threadId: caller, sequence: log.nextSequence(), text }));
      expect((await gate(coordination)).kind).toBe("allowed");
    },
  );

  it("does not count a reply typed before the challenge was issued", async () => {
    const { coordination, log } = makeTestCoordination({ generateCode: () => "BB-FIXED000" });
    log.push(messageEvent({ threadId: caller, sequence: 1, text: "allow BB-FIXED000" }));
    requiredCode(await gate(coordination));
    expect((await gate(coordination)).kind).toBe("confirmation_required");
    log.push(messageEvent({ threadId: caller, sequence: 2, text: "allow BB-FIXED000" }));
    expect((await gate(coordination)).kind).toBe("allowed");
  });

  it("pages past many candidates, and fails closed with a fresh code past the scan cap", async () => {
    const paged = makeTestCoordination();
    requiredCode(await gate(paged.coordination));
    for (let index = 0; index < 450; index += 1) {
      paged.log.push(
        queuedPromptEvent({ threadId: caller, sequence: paged.log.nextSequence(), text: "x" }),
      );
    }
    paged.log.push(
      messageEvent({ threadId: caller, sequence: paged.log.nextSequence(), text: "yes" }),
    );
    expect((await gate(paged.coordination)).kind).toBe("allowed");

    const capped = makeTestCoordination();
    const original = requiredCode(await gate(capped.coordination));
    for (let index = 0; index <= THREAD_COORDINATION_PROOF_SCAN_CAP; index += 1) {
      capped.log.push(
        queuedPromptEvent({ threadId: caller, sequence: capped.log.nextSequence(), text: "x" }),
      );
    }
    capped.log.push(
      messageEvent({ threadId: caller, sequence: capped.log.nextSequence(), text: "yes" }),
    );
    const refreshed = requiredCode(await gate(capped.coordination));
    expect(refreshed.code).not.toBe(original.code);
  });
});
