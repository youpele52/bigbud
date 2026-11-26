import { describe, expect, it } from "vitest";
import { checkRollbackBoundary } from "./check.ts";

// Synthetic normalized records only; no process or database is opened by these tests.
const hash = (digit: string) => digit.repeat(64);

function fixture() {
  const a = { id: "a-dmg", build: "a-build", sha256: hash("a") };
  const b = { id: "b-dmg", build: "b-build", sha256: hash("b") };
  const metadata = {
    schemaCeiling: 181,
    schemaSha256: hash("1"),
    migration: 181,
    migrationSha256: hash("2"),
  };
  const owner = { id: "owner", build: "owner-build", sha256: hash("c") };
  const binding = {
    slot: "D.darwin.arm64.dmg",
    cell: "fixture-cell",
    disposition: "required",
    identity: {
      a,
      b,
      artifactVerification: "developer-id-notarized",
      dbDomain: "fixture-domain",
      schemaA: 181,
      schemaB: 181,
      migration: 181,
      platform: {
        os: "darwin",
        arch: "arm64",
        osBuild: "fixture-os",
        abi: "macho-fixture",
        runtimeBuild: "electron-fixture",
        sshOrigin: "system",
        sshVersion: "OpenSSH_9.9p1",
        sshSha256: hash("d"),
      },
      owner: { image: owner, protocol: "v1" },
      askpass: null,
    },
  };
  const bInventory = [
    { component: "backend", role: "launcher", imageSha256: hash("3") },
    { component: "owner", role: "owner", imageSha256: owner.sha256 },
    { component: "pty", role: "transport", imageSha256: hash("d") },
  ];
  const snapshot = (seq: number, holders: string[], logicalSha256 = hash("4")) => ({
    seq,
    fence: "fixture-fence",
    db: {
      domain: binding.identity.dbDomain,
      instance: "fixture-db-instance",
      metadata: { ...metadata },
      logicalSha256,
      holders,
    },
  });
  const aImageSha256 = hash("5");
  return {
    plan: { kind: "rollback-boundary-plan-v1", binding, metadata, aImageSha256, bInventory },
    observations: {
      kind: "rollback-boundary-observations-v1",
      binding: structuredClone(binding),
      a: { artifact: { ...a }, executor: "legacy-ts", metadata: { ...metadata } },
      b: { artifact: { ...b }, executor: "rust-owner", metadata: { ...metadata } },
      capture: {
        complete: true,
        lostEvents: 0,
        fenceContinuous: true,
        otherBStarts: 0,
        otherAStarts: 0,
      },
      before: snapshot(1, ["b-backend"], hash("6")),
      drained: snapshot(5, ["b-backend"]),
      storageRevokedAt: 6,
      retirements: bInventory.map(({ component, imageSha256 }, index) => {
        const process = { instance: `b-${component}`, imageSha256 };
        return {
          component,
          before: process,
          exit: { ...process },
          status: "verified-exit",
          seq: [8, 7, 3][index]!,
        };
      }),
      boundary: snapshot(9, []),
      aStart: { seq: 10, process: { instance: "a-backend", imageSha256: aImageSha256 } },
      aOpen: snapshot(11, ["a-backend"]),
    },
  };
}

type Fixture = ReturnType<typeof fixture>;
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
      "A opens before storage revocation",
      (f) => {
        f.observations.storageRevokedAt = 12;
      },
      /out of order/,
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
      "changed release fence token",
      (f) => {
        f.observations.aOpen.fence = "other-fence";
      },
      /fence identity/,
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
      "temporary loss of the fence",
      (f) => {
        f.observations.capture.fenceContinuous = false;
      },
      /Uncertain capture/,
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
