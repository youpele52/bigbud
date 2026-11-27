// Synthetic normalized records only; no process or database is opened by these tests.
export const hash = (digit: string) => digit.repeat(64);

export function fixture() {
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
  const snapshot = (
    seq: number,
    holders: string[],
    lock: string | null,
    logicalSha256 = hash("4"),
  ) => ({
    seq,
    lock,
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
    plan: {
      kind: "rollback-boundary-plan-v2",
      binding,
      metadata,
      aImageSha256,
      bInventory,
      bRecordArtifactSha256: hash("7"),
    },
    observations: {
      kind: "rollback-boundary-observations-v2",
      binding: structuredClone(binding),
      a: { artifact: { ...a }, executor: "legacy-ts", metadata: { ...metadata } },
      b: { artifact: { ...b }, executor: "rust-owner", metadata: { ...metadata } },
      capture: { complete: true, lostEvents: 0, otherBStarts: 0, otherAStarts: 0 },
      before: snapshot(1, ["b-backend"], "b-backend", hash("6")),
      drain: {
        seq: 2,
        status: "drained",
        owner: { masters: 1, leases: 0, attachCleared: true },
        record: {
          artifactSha256: hash("7"),
          ownerEpoch: "owner-epoch" as string | null,
          owner: { masters: 1, leases: 0, attachCleared: true } as {
            masters: number;
            leases: number;
            attachCleared: boolean;
          } | null,
        },
        legacyMarkerSha256: { before: hash("8"), drained: hash("8") },
      },
      drained: snapshot(5, ["b-backend"], "b-backend"),
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
      boundary: snapshot(9, [], null),
      aStart: { seq: 10, process: { instance: "a-backend", imageSha256: aImageSha256 } },
      aOpen: snapshot(11, ["a-backend"], "a-backend"),
    },
  };
}

export type Fixture = ReturnType<typeof fixture>;
