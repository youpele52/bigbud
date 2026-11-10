import { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  THREAD_COORDINATION_CHALLENGE_TTL_MS,
  makeThreadCoordinationGrants,
} from "./ThreadCoordinationGrants.ts";

const caller = ThreadId.makeUnsafe("caller");
const otherCaller = ThreadId.makeUnsafe("other-caller");
const projectB = ProjectId.makeUnsafe("project-b");
const projectC = ProjectId.makeUnsafe("project-c");

const request = (overrides: Partial<{ callerThreadId: ThreadId; projectId: ProjectId }> = {}) => ({
  callerThreadId: caller,
  projectId: projectB,
  projectTitle: "B",
  targetIsRemote: false,
  streamSequenceFloor: 7,
  ...overrides,
});

describe("ThreadCoordinationGrants", () => {
  it("issues, reuses, and re-issues a challenge after its 30 minute expiry", async () => {
    let now = 1_000;
    let counter = 0;
    const grants = Effect.runSync(
      makeThreadCoordinationGrants({
        now: () => now,
        generateCode: () => `BB-CODE000${++counter}`,
      }),
    );
    const first = await Effect.runPromise(grants.getOrIssueChallenge(request()));
    expect(first).toMatchObject({
      issued: true,
      challenge: {
        code: "BB-CODE0001",
        projectTitle: "B",
        streamSequenceFloor: 7,
        expiresAt: 1_000 + THREAD_COORDINATION_CHALLENGE_TTL_MS,
      },
    });
    now += THREAD_COORDINATION_CHALLENGE_TTL_MS - 1;
    const reused = await Effect.runPromise(
      grants.getOrIssueChallenge({ ...request(), projectTitle: "Renamed" }),
    );
    expect(reused).toMatchObject({ issued: false, challenge: { code: "BB-CODE0001" } });
    expect(reused.challenge.projectTitle).toBe("B");
    now += 1;
    expect(Option.isNone(await Effect.runPromise(grants.getChallenge(caller, projectB)))).toBe(
      true,
    );
    const renewed = await Effect.runPromise(grants.getOrIssueChallenge(request()));
    expect(renewed).toMatchObject({ issued: true });
    expect(renewed.challenge.code).not.toBe("BB-CODE0001");
  });

  it("shares one challenge between concurrent issuers for the same pair", async () => {
    const grants = Effect.runSync(makeThreadCoordinationGrants());
    const results = await Effect.runPromise(
      Effect.all([grants.getOrIssueChallenge(request()), grants.getOrIssueChallenge(request())], {
        concurrency: "unbounded",
      }),
    );
    expect(results[0].challenge.code).toBe(results[1].challenge.code);
    expect(results.filter((result) => result.issued)).toHaveLength(1);
  });

  it("grants only the exact (caller, project) pair and clears its challenge", async () => {
    const grants = Effect.runSync(makeThreadCoordinationGrants());
    await Effect.runPromise(grants.getOrIssueChallenge(request()));
    await Effect.runPromise(grants.grant(caller, projectB));
    await Effect.runPromise(grants.grant(caller, projectB));
    expect(await Effect.runPromise(grants.hasGrant(caller, projectB))).toBe(true);
    expect(await Effect.runPromise(grants.hasGrant(caller, projectC))).toBe(false);
    expect(await Effect.runPromise(grants.hasGrant(otherCaller, projectB))).toBe(false);
    expect(Option.isNone(await Effect.runPromise(grants.getChallenge(caller, projectB)))).toBe(
      true,
    );
  });

  it("clears a challenge only when the expected code still matches", async () => {
    const grants = Effect.runSync(makeThreadCoordinationGrants());
    const { challenge } = await Effect.runPromise(grants.getOrIssueChallenge(request()));
    await Effect.runPromise(grants.clearChallenge(caller, projectB, "BB-STALE000"));
    expect(Option.isSome(await Effect.runPromise(grants.getChallenge(caller, projectB)))).toBe(
      true,
    );
    await Effect.runPromise(grants.clearChallenge(caller, projectB, challenge.code));
    expect(Option.isNone(await Effect.runPromise(grants.getChallenge(caller, projectB)))).toBe(
      true,
    );
  });

  it("orders issued challenges and keeps resolved ones in the caller's history", async () => {
    let counter = 0;
    const grants = Effect.runSync(
      makeThreadCoordinationGrants({ generateCode: () => `BB-CODE000${++counter}` }),
    );
    const b = await Effect.runPromise(grants.getOrIssueChallenge(request()));
    const c = await Effect.runPromise(
      grants.getOrIssueChallenge({ ...request({ projectId: projectC }), streamSequenceFloor: 9 }),
    );
    await Effect.runPromise(grants.getOrIssueChallenge(request({ callerThreadId: otherCaller })));
    expect(c.challenge.issueOrder).toBeGreaterThan(b.challenge.issueOrder);

    await Effect.runPromise(grants.grant(caller, projectC, { resolvedAtSequence: 12 }));
    await Effect.runPromise(
      grants.clearChallenge(caller, projectB, b.challenge.code, { resolvedAtSequence: 14 }),
    );
    // A later resolution never moves an earlier one.
    await Effect.runPromise(grants.grant(caller, projectC, { resolvedAtSequence: 20 }));
    expect(await Effect.runPromise(grants.listIssuedChallenges(caller))).toEqual([
      {
        projectId: projectB,
        code: "BB-CODE0001",
        streamSequenceFloor: 7,
        issueOrder: b.challenge.issueOrder,
        resolvedAtSequence: 14,
      },
      {
        projectId: projectC,
        code: "BB-CODE0002",
        streamSequenceFloor: 9,
        issueOrder: c.challenge.issueOrder,
        resolvedAtSequence: 12,
      },
    ]);
    expect(await Effect.runPromise(grants.listIssuedChallenges(otherCaller))).toHaveLength(1);
  });

  it("drops history older than twice the challenge lifetime", async () => {
    let now = 1_000;
    const grants = Effect.runSync(makeThreadCoordinationGrants({ now: () => now }));
    await Effect.runPromise(grants.getOrIssueChallenge(request()));
    await Effect.runPromise(grants.getOrIssueChallenge(request({ callerThreadId: otherCaller })));
    now += 2 * THREAD_COORDINATION_CHALLENGE_TTL_MS;
    await Effect.runPromise(grants.getOrIssueChallenge(request({ projectId: projectC })));
    expect(
      (await Effect.runPromise(grants.listIssuedChallenges(caller))).map(
        (record) => record.projectId,
      ),
    ).toEqual([projectC]);
    expect(await Effect.runPromise(grants.listIssuedChallenges(otherCaller))).toEqual([]);
  });
});
