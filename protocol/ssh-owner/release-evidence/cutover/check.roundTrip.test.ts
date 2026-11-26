import { describe, expect, it } from "vitest";
import { hash } from "../forward/check.fixture.ts";
import { checkForwardBoundary } from "../forward/check.ts";
import { checkRollbackBoundary } from "../rollback/check.ts";
import { fixture } from "./check.roundTrip.fixture.ts";
import { checkRoundTrip } from "./check.roundTrip.ts";

type Fixture = ReturnType<typeof fixture>;
const check = ({ matrix, evidence }: Fixture) => checkRoundTrip(matrix, evidence);

function rollbackSnapshots({ evidence }: Fixture) {
  const { before, drained, boundary, aOpen } = evidence.rollback.observations;
  return [before, drained, boundary, aOpen];
}

describe("offline A/B round-trip evidence continuity", () => {
  it("compares one ordered synthetic record set without authenticating or qualifying it", () => {
    expect(check(fixture())).toEqual({
      status: "round-trip-observations-conform",
      scopeReview: "synthetic-scope-review",
      slot: "D.darwin.arm64.dmg",
      cell: "fixture-cell",
      forwardCaptureEnd: 30,
      rollbackStart: 40,
      observationsAuthenticated: false,
      rollbackQualified: false,
      s4Accepted: false,
    });
  });

  it.each(["a", "b"] as const)("rejects a different %s digest in the reviewed matrix", (side) => {
    const f = fixture();
    const reviewed = f.matrix.cells.find(({ cell }) => cell === "fixture-cell")!;
    reviewed.identity![side].sha256 = hash("9");
    expect(() => check(f)).toThrow(/exact reviewed matrix cell and artifacts/);
  });

  it("does not accept a preflight, a different scope review, or a broken shared capture", () => {
    const f = fixture();
    expect(() => checkRoundTrip(f.matrix, { status: "preflight-only" })).toThrow();
    f.evidence.scopeReview = "other-review";
    expect(() => check(f)).toThrow(/matrix scope review/);
    f.evidence.scopeReview = f.matrix.scopeReview;
    f.evidence.capture.fenceContinuous = false;
    expect(() => check(f)).toThrow(/one continuous round-trip capture/);
    f.evidence.capture.fenceContinuous = true;
    f.evidence.capture.otherBStarts = 1;
    expect(() => check(f)).toThrow(/unaccounted A\/B starts/);
  });

  const splices: Array<[string, (f: Fixture) => void, RegExp]> = [
    [
      "another profile instance",
      ({ evidence }) => {
        evidence.rollback.profileInstance = "other-profile";
      },
      /Profile, DB instance/,
    ],
    [
      "an internally consistent copied DB",
      (f) => {
        for (const { db } of rollbackSnapshots(f)) db.instance = "copied-db";
      },
      /Profile, DB instance/,
    ],
    [
      "a separately acquired release fence",
      (f) => {
        for (const snapshot of rollbackSnapshots(f)) snapshot.fence = "different-fence";
      },
      /release fence/,
    ],
    [
      "different migration bytes under the same schema numbers",
      (f) => {
        const { plan, observations } = f.evidence.rollback;
        for (const metadata of [
          plan.metadata,
          observations.a.metadata,
          observations.b.metadata,
          ...rollbackSnapshots(f).map(({ db }) => db.metadata),
        ]) {
          metadata.migrationSha256 = hash("9");
        }
      },
      /schema\/migration identity/,
    ],
    [
      "an overlapping rollback",
      ({ evidence }) => {
        evidence.rollback.observations.before.seq = 29;
      },
      /after the forward capture/,
    ],
    [
      "a reused recorder position at the join",
      ({ evidence }) => {
        evidence.rollback.observations.before.seq = 30;
      },
      /after the forward capture/,
    ],
    [
      "another B owner lifetime with the correct image",
      ({ evidence }) => {
        const { before, exit } = evidence.rollback.observations.retirements[1]!;
        before.instance = exit.instance = "replacement-owner";
      },
      /Process lifetimes/,
    ],
    [
      "another B writer lifetime with the correct image",
      ({ evidence }) => {
        const { before, drained, retirements } = evidence.rollback.observations;
        before.db.holders = drained.db.holders = ["replacement-writer"];
        retirements[0]!.before.instance = retirements[0]!.exit.instance = "replacement-writer";
      },
      /Process lifetimes/,
    ],
    [
      "an already retired A lifetime reopening the DB",
      ({ evidence }) => {
        const { aStart, aOpen } = evidence.rollback.observations;
        aStart.process.instance = evidence.forward.observations.retirements[0]!.exit.instance;
        aOpen.db.holders = [aStart.process.instance];
      },
      /Process lifetimes/,
    ],
  ];
  it.each(splices)("rejects %s even when both standalone checkers pass", (_name, change, error) => {
    const f = fixture();
    change(f);
    const { forward, rollback } = f.evidence;
    expect(() => checkForwardBoundary(forward.plan, forward.observations)).not.toThrow();
    expect(() => checkRollbackBoundary(rollback.plan, rollback.observations)).not.toThrow();
    expect(() => check(f)).toThrow(error);
  });

  it("still requires forward v2 refusals and rollback DB consistency", () => {
    const missingRefusal = fixture();
    missingRefusal.evidence.forward.observations.relaunches.pop();
    expect(() => check(missingRefusal)).toThrow(/Missing legacy relaunch observations/);
    const changedState = fixture();
    changedState.evidence.rollback.observations.aOpen.db.logicalSha256 = hash("9");
    expect(() => check(changedState)).toThrow(/Committed DB state changed/);
  });
});
