import { describe, expect, it } from "vitest";
import { checkRollbackBoundary } from "./check.ts";
import { fixture, hash, type Fixture } from "./check.fixture.ts";

const check = ({ plan, observations }: Fixture) => checkRollbackBoundary(plan, observations);

describe("offline rollback boundary observations", () => {
  it("compares normalized artifact, process and DB observations without qualifying rollback", () => {
    expect(check(fixture())).toEqual({
      status: "rollback-boundary-conforms",
      slot: "D.darwin.arm64.dmg",
      cell: "fixture-cell",
      retiredProcesses: 3,
      observationsAuthenticated: false,
      rollbackQualified: false,
      s4Accepted: false,
    });
  });

  it("rejects missing observations and matrix references posing as observations", () => {
    const f = fixture();
    const { aOpen: _omitted, ...missingOpen } = f.observations;
    expect(() => checkRollbackBoundary(f.plan, missingOpen)).toThrow(/Expected exactly/);
    f.observations.kind = "s4-matrix-claim-references-v1";
    expect(() => check(f)).toThrow(/not claim references/);
    f.observations.kind = "rollback-boundary-observations-v1";
    expect(() => check(f)).toThrow(/v2 rollback/);
  });

  it("rejects a valid binding from another profile, even with the same cell and DB tokens", () => {
    const f = fixture();
    f.observations.binding.slot = "V-E.darwin.arm64.electron-dev";
    f.observations.binding.identity.artifactVerification = "verified-development-inputs";
    expect(() => check(f)).toThrow(/Mismatched rollback matrix cell binding/);
  });

  const failures: Array<[string, (f: Fixture) => void, RegExp]> = [
    [
      "different A artifact",
      (f) => {
        f.observations.a.artifact.sha256 = hash("9");
      },
      /A\/B artifact/,
    ],
    [
      "older A ceiling",
      (f) => {
        f.observations.a.metadata.schemaCeiling--;
      },
      /A\/B artifact/,
    ],
    [
      "different B migration bytes",
      (f) => {
        f.observations.b.metadata.migrationSha256 = hash("9");
      },
      /A\/B artifact/,
    ],
    [
      "wrong B executor",
      (f) => {
        f.observations.b.executor = "legacy-ts";
      },
      /rust-owner/,
    ],
    [
      "unknown DB schema",
      (f) => {
        f.observations.aOpen.db.metadata.schemaSha256 = hash("9");
      },
      /Observed DB schema/,
    ],
    [
      "another DB domain",
      (f) => {
        f.observations.aOpen.db.domain = "other-domain";
      },
      /DB domain or instance/,
    ],
    [
      "a copied DB with identical state",
      (f) => {
        f.observations.aOpen.db.instance = "copied-db";
      },
      /DB domain or instance/,
    ],
    [
      "committed state lost before A starts",
      (f) => {
        f.observations.boundary.db.logicalSha256 = hash("9");
      },
      /Committed DB state/,
    ],
    [
      "committed state changed by A startup",
      (f) => {
        f.observations.aOpen.db.logicalSha256 = hash("9");
      },
      /Committed DB state/,
    ],
    [
      "missing B transport exit",
      (f) => {
        f.observations.retirements.pop();
      },
      /Missing B retirement/,
    ],
    [
      "uncertain B transport retirement",
      (f) => {
        f.observations.retirements[2]!.status = "uncertain";
      },
      /Uncertain B process retirement/,
    ],
    [
      "B exit for a different instance",
      (f) => {
        f.observations.retirements[1]!.exit.instance = "other-owner";
      },
      /mismatched, or late B process/,
    ],
    [
      "wrong B owner image in frozen inventory",
      (f) => {
        f.plan.bInventory[1]!.imageSha256 = hash("9");
      },
      /bound owner image/,
    ],
    [
      "B exit after the boundary",
      (f) => {
        f.observations.retirements[1]!.seq = 12;
      },
      /late B process/,
    ],
    [
      "two retirements sharing a single recorder event",
      (f) => {
        f.observations.retirements[1]!.seq = f.observations.retirements[0]!.seq;
      },
      /duplicate.*B process/,
    ],
    [
      "DB holder already exited before drain snapshot",
      (f) => {
        f.observations.retirements[0]!.seq = 4;
      },
      /mismatched, or late B process/,
    ],
    [
      "unknown B DB holder",
      (f) => {
        f.observations.before.db.holders.push("other-process");
      },
      /known B DB holders/,
    ],
    [
      "B still holds the DB at the boundary",
      (f) => {
        f.observations.boundary.db.holders.push("b-owner");
      },
      /zero holders/,
    ],
    [
      "A opens before B's drain answered",
      (f) => {
        f.observations.drain.seq = 12;
      },
      /out of order/,
    ],
    [
      "an owner that kept its attach record",
      (f) => {
        f.observations.drain.owner.attachCleared = false;
        f.observations.drain.record.owner!.attachCleared = false;
      },
      /attach record/,
    ],
    [
      "a retirement record from another B artifact",
      (f) => {
        f.observations.drain.record.artifactSha256 = hash("9");
      },
      /retirement record/,
    ],
    [
      "a record whose owner counts differ from the shutdown report",
      (f) => {
        f.observations.drain.record.owner!.masters = 0;
      },
      /retirement record/,
    ],
    [
      "a record without the drained owner",
      (f) => {
        f.observations.drain.record.owner = null;
        f.observations.drain.record.ownerEpoch = null;
      },
      /retirement record/,
    ],
    [
      "a drain that rewrote A's legacy marker",
      (f) => {
        f.observations.drain.legacyMarkerSha256.drained = hash("9");
      },
      /legacy retirement marker/,
    ],
    [
      "A startup before the boundary",
      (f) => {
        f.observations.aStart.seq = 8;
      },
      /out of order/,
    ],
    [
      "wrong executable at A startup",
      (f) => {
        f.observations.aStart.process.imageSha256 = hash("9");
      },
      /A startup process/,
    ],
    [
      "reused B process identity at A startup",
      (f) => {
        f.observations.aStart.process.instance = "b-backend";
      },
      /reuses B identity/,
    ],
    [
      "wrong A DB holder",
      (f) => {
        f.observations.aOpen.db.holders = ["b-backend"];
      },
      /first-open DB holder/,
    ],
    [
      "another process holding the lock at A's first open",
      (f) => {
        f.observations.aOpen.lock = "other-process";
      },
      /State-dir lock/,
    ],
    [
      "a free lock before B's drain",
      (f) => {
        f.observations.before.lock = null;
      },
      /State-dir lock/,
    ],
    [
      "a lock still held at the boundary",
      (f) => {
        f.observations.boundary.lock = "b-backend";
      },
      /State-dir lock/,
    ],
    [
      "the lock passing to another B process after the drain",
      (f) => {
        f.observations.drained.lock = "b-owner";
      },
      /State-dir lock/,
    ],
    [
      "incomplete capture",
      (f) => {
        f.observations.capture.complete = false;
      },
      /Uncertain capture/,
    ],
    [
      "lost recorder events",
      (f) => {
        f.observations.capture.lostEvents++;
      },
      /Uncertain capture/,
    ],
    [
      "a drain that did not answer drained",
      (f) => {
        f.observations.drain.status = "cancelled";
      },
      /answered drain/,
    ],
    [
      "B attempted relaunch that started",
      (f) => {
        f.observations.capture.otherBStarts++;
      },
      /overlapping managed launches/,
    ],
    [
      "unaccounted-for start of A",
      (f) => {
        f.observations.capture.otherAStarts++;
      },
      /overlapping managed launches/,
    ],
  ];
  it.each(failures)("rejects %s", (_name, change, error) => {
    const f = fixture();
    change(f);
    expect(() => check(f)).toThrow(error);
  });
});
