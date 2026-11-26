import { describe, expect, it } from "vitest";
import { checkForwardBoundary } from "./check.ts";

import { fixture, hash, type Fixture } from "./check.fixture.ts";

const check = ({ plan, observations }: Fixture) => checkForwardBoundary(plan, observations);

describe("offline forward boundary observations", () => {
  it.each([null, "old-epoch"])(
    "checks handoff from epoch %s without reporting qualification",
    (prior) => {
      expect(check(fixture(prior))).toEqual({
        status: "forward-boundary-observations-conform",
        slot: "D.darwin.arm64.dmg",
        cell: "fixture-cell",
        retiredProcesses: 3,
        observedRelaunchRefusals: 4,
      });
    },
  );

  it("rejects omissions and evidence that is only a claim reference", () => {
    const { plan, observations } = fixture();
    const { admission: _admission, ...missing } = observations;
    expect(() => checkForwardBoundary(plan, missing)).toThrow(/Expected exactly/);
    observations.kind = "s4-matrix-claim-references-v1";
    expect(() => checkForwardBoundary(plan, observations)).toThrow(/not claim references/);
  });

  it("rejects passive v1 evidence even with no observed A starts", () => {
    const { plan, observations } = fixture();
    const { legacyEntries: _entries, ...passivePlan } = plan;
    const { relaunches: _relaunches, ...passive } = observations;
    expect(() =>
      checkForwardBoundary({ ...passivePlan, kind: "forward-boundary-plan-v1" }, passive),
    ).toThrow(/Expected exactly/);
    expect(() =>
      checkForwardBoundary(plan, { ...passive, kind: "forward-boundary-observations-v1" }),
    ).toThrow(/Expected exactly/);
  });

  it("requires real records for every frozen entry, including a second route and a dormant launcher", () => {
    const { plan, observations } = fixture();
    const relaunches = observations.relaunches;
    for (const entry of ["terminal-restart", "offline-monitor"]) {
      observations.relaunches = relaunches.filter(({ request }) => request.entry !== entry);
      expect(() => checkForwardBoundary(plan, observations)).toThrow(
        new RegExp(`Missing.*${entry}`),
      );
    }
    observations.relaunches = [];
    expect(() => checkForwardBoundary(plan, observations)).toThrow();
    plan.legacyEntries = plan.legacyEntries.filter(({ component }) => component !== "detached");
    observations.relaunches = relaunches.filter(
      ({ request }) => !request.entry.startsWith("terminal-"),
    );
    expect(() => checkForwardBoundary(plan, observations)).toThrow(
      /covering every observed A launcher/,
    );
  });

  it("rejects bare claim references and checks the request and refusal independently", () => {
    const { plan, observations } = fixture();
    const [first, second, ...rest] = observations.relaunches;
    const verify = (record: unknown) =>
      checkForwardBoundary(plan, { ...observations, relaunches: [record, second, ...rest] });
    const { request, result } = first!;
    expect(() => verify({ ref: "claim-legacy-retirement" })).toThrow(/Expected exactly/);
    expect(() => verify({ request, result: { ...result, outcome: "timed-out" } })).toThrow(
      /observed legacy fence refusal/,
    );
    expect(() =>
      verify({ request, result: { ...result, attempt: second!.result.attempt } }),
    ).toThrow(/mismatched legacy attempt/);
    expect(() => verify({ request: { ...request, entry: "unknown" }, result })).toThrow(
      /unexpected.*legacy attempt/,
    );
    expect(() =>
      verify({
        request: { ...request, entry: second!.request.entry, caller: second!.request.caller },
        result,
      }),
    ).toThrow(/unexpected.*legacy attempt/);
    expect(() =>
      verify({
        request: { ...request, caller: { ...request.caller, imageSha256: hash("0") } },
        result,
      }),
    ).toThrow(/mismatched legacy attempt/);
    expect(() =>
      verify({
        request: { ...request, caller: { ...request.caller, instance: "a-backend" } },
        result,
      }),
    ).toThrow(/mismatched legacy attempt/);
    expect(() => verify({ request, result: { ...result, fence: "other-fence" } })).toThrow(
      /not bound/,
    );
    expect(() => verify({ request: { ...request, dbInstance: "other-db" }, result })).toThrow(
      /not bound/,
    );
    expect(() => verify({ request, result: { ...result, dbInstance: "other-db" } })).toThrow(
      /not bound/,
    );
  });

  it("requires distinct ordered events inside the continuously fenced capture, with no legacy spawn", () => {
    const { plan, observations } = fixture();
    const [pair, second] = observations.relaunches;
    const { request, result } = pair!;
    const verify = () => checkForwardBoundary(plan, observations);
    for (const seq of [request.seq, second!.request.seq, observations.capture.endSeq]) {
      pair!.result = { ...result, seq };
      expect(verify).toThrow(/invalid legacy attempt ordering/);
    }
    pair!.result = result;
    pair!.request = { ...request, seq: observations.admission.seq };
    expect(verify).toThrow(/invalid legacy attempt ordering/);
    pair!.request = request;
    observations.capture.legacyTransportStarts = 1;
    expect(verify).toThrow(/overlapping managed launches/);
  });

  const failures: [string, (fixture: Fixture) => void, RegExp][] = [
    [
      "different profile type with the same cell and DB tokens",
      (f) => {
        f.observations.binding.slot = "V-E.darwin.arm64.electron-dev";
        f.observations.binding.identity.artifactVerification = "verified-development-inputs";
      },
      /matrix cell or profile instance/,
    ],
    [
      "different profile instance",
      (f) => {
        f.observations.profileInstance = "other-profile";
      },
      /profile instance/,
    ],
    [
      "wrong A artifact",
      (f) => {
        f.observations.a.artifact.sha256 = hash("8");
      },
      /A\/B artifact/,
    ],
    [
      "wrong B migration",
      (f) => {
        f.observations.b.metadata.migrationSha256 = hash("8");
      },
      /A\/B artifact/,
    ],
    [
      "unexpected B executor",
      (f) => {
        f.observations.b.executor = "legacy-ts";
      },
      /rust-owner/,
    ],
    [
      "different DB domain",
      (f) => {
        f.observations.takeover.snapshot.db.domain = "other-domain";
      },
      /DB domain or instance/,
    ],
    [
      "copied DB with identical contents",
      (f) => {
        f.observations.takeover.snapshot.db.instance = "copied-db";
      },
      /DB domain or instance/,
    ],
    [
      "different DB schema",
      (f) => {
        f.observations.boundary.snapshot.db.metadata.schemaSha256 = hash("8");
      },
      /Observed DB schema/,
    ],
    [
      "missing detached launcher exit",
      (f) => {
        f.observations.retirements.splice(1, 1);
      },
      /Missing A retirement/,
    ],
    [
      "uncertain exit",
      (f) => {
        f.observations.retirements[1]!.status = "snapshot-only";
      },
      /Uncertain A/,
    ],
    [
      "exit of a different process instance",
      (f) => {
        f.observations.retirements[1]!.exit.instance = "other-terminal";
      },
      /mismatched.*A process/,
    ],
    [
      "exit of a different process image",
      (f) => {
        f.observations.retirements[1]!.exit.imageSha256 = hash("8");
      },
      /mismatched.*A process/,
    ],
    [
      "duplicate exit event",
      (f) => {
        f.observations.retirements[1]!.seq = f.observations.retirements[0]!.seq;
      },
      /duplicate.*A process/,
    ],
    [
      "exit at the boundary",
      (f) => {
        f.observations.retirements[1]!.seq = f.observations.boundary.snapshot.seq;
      },
      /late A process/,
    ],
    [
      "duplicate frozen lifetime",
      (f) => {
        f.plan.aInventory[1]!.process.instance = "a-backend";
      },
      /unique A process/,
    ],
    [
      "unknown initial handle holder",
      (f) => {
        f.observations.before.db.holders.push("other-writer");
      },
      /exact frozen A DB holders/,
    ],
    [
      "missing initial writer observation",
      (f) => {
        f.observations.before.db.holders = [];
      },
      /exact frozen A DB holders/,
    ],
    [
      "open handle at the boundary",
      (f) => {
        f.observations.boundary.snapshot.db.holders.push("a-backend");
      },
      /zero holders/,
    ],
    [
      "B startup before the boundary",
      (f) => {
        f.observations.bStart.seq = 4;
      },
      /out of order/,
    ],
    [
      "different B writer image",
      (f) => {
        f.observations.bStart.process.imageSha256 = hash("8");
      },
      /B writer does not match/,
    ],
    [
      "B writer reusing an A lifetime",
      (f) => {
        f.observations.bStart.process.instance = "a-backend";
      },
      /reuses an A instance/,
    ],
    [
      "an extra handle during takeover",
      (f) => {
        f.observations.takeover.snapshot.db.holders.push("a-backend");
      },
      /exactly the verified B writer/,
    ],
    [
      "state changed during takeover",
      (f) => {
        f.observations.takeover.snapshot.db.logicalSha256 = hash("8");
      },
      /preserve and hydrate/,
    ],
    [
      "stale hydrated state",
      (f) => {
        f.observations.takeover.hydratedLogicalSha256 = hash("8");
      },
      /preserve and hydrate/,
    ],
    [
      "uncommitted takeover",
      (f) => {
        f.observations.takeover.outcome = "request-sent";
      },
      /Expected committed/,
    ],
    [
      "CAS against the wrong prior epoch",
      (f) => {
        f.observations.takeover.previousEpoch = null;
      },
      /observed prior writer epoch/,
    ],
    [
      "epoch not rotated",
      (f) => {
        f.observations.takeover.writerEpoch = "old-epoch";
        f.observations.admission.writerEpoch = "old-epoch";
      },
      /new epoch/,
    ],
    [
      "admission using a stale epoch",
      (f) => {
        f.observations.admission.writerEpoch = "old-epoch";
      },
      /new epoch/,
    ],
    [
      "admission on the same event as commit",
      (f) => {
        f.observations.admission.seq = f.observations.takeover.snapshot.seq;
      },
      /out of order/,
    ],
    [
      "admission for another DB",
      (f) => {
        f.observations.admission.dbInstance = "other-db";
      },
      /not bound/,
    ],
    [
      "admission by a different owner image",
      (f) => {
        f.observations.admission.owner.imageSha256 = hash("8");
      },
      /matrix owner image/,
    ],
    [
      "replacement release fence",
      (f) => {
        f.observations.boundary.snapshot.fence = "other-fence";
      },
      /Release fence changed/,
    ],
    [
      "snapshot-only capture",
      (f) => {
        f.observations.capture.scope = "snapshot-only";
      },
      /Uncertain capture/,
    ],
    [
      "incomplete observation",
      (f) => {
        f.observations.capture.complete = false;
      },
      /Uncertain capture/,
    ],
    [
      "recorder event loss",
      (f) => {
        f.observations.capture.lostEvents = 1;
      },
      /Uncertain capture/,
    ],
    [
      "temporary fence loss",
      (f) => {
        f.observations.capture.fenceContinuous = false;
      },
      /Uncertain capture/,
    ],
    [
      "observed relaunch of A",
      (f) => {
        f.observations.capture.otherAStarts = 1;
      },
      /overlapping managed launches/,
    ],
    [
      "observed competing B start",
      (f) => {
        f.observations.capture.otherBStarts = 1;
      },
      /overlapping managed launches/,
    ],
  ];

  it.each(failures)("rejects %s", (_name, mutate, error) => {
    const f = fixture();
    mutate(f);
    expect(() => check(f)).toThrow(error);
  });
});
