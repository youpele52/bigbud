export const hash = (digit: string) => digit.repeat(64);

// Synthetic normalized records only. No app, OS process recorder, or SQLite fixture is started.
export function fixture(previousEpoch: string | null = "old-epoch") {
  const a = { id: "a-dmg", build: "a-build", sha256: hash("a") };
  const b = { id: "b-dmg", build: "b-build", sha256: hash("b") };
  const ownerImage = { id: "owner", build: "owner-build", sha256: hash("c") };
  const metadata = {
    schemaCeiling: 181,
    schemaSha256: hash("1"),
    migration: 181,
    migrationSha256: hash("2"),
  };
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
      owner: { image: ownerImage, protocol: "v1" },
      askpass: null,
    },
  };
  const aInventory = [
    {
      component: "backend",
      role: "launcher",
      process: { instance: "a-backend", imageSha256: hash("3") },
      dbHolder: true,
    },
    {
      component: "detached",
      role: "launcher",
      process: { instance: "a-terminal", imageSha256: hash("4") },
      dbHolder: false,
    },
    {
      component: "pty",
      role: "transport",
      process: { instance: "a-pty", imageSha256: hash("d") },
      dbHolder: false,
    },
  ];
  const legacyEntries = [
    { id: "backend-start", component: "backend", callerImageSha256: hash("a") },
    { id: "terminal-open", component: "detached", callerImageSha256: hash("b") },
    { id: "terminal-restart", component: "detached", callerImageSha256: hash("c") },
    { id: "offline-monitor", component: "monitor", callerImageSha256: hash("e") },
  ];
  const profileInstance = "isolated-fixture-profile";
  const dbInstance = "fixture-db-instance";
  const bWriterImageSha256 = hash("5");
  const writerEpoch = "new-epoch";
  const snapshot = (
    seq: number,
    holders: string[],
    lock: string | null,
    logicalSha256 = hash("6"),
  ) => ({
    seq,
    lock,
    db: {
      domain: binding.identity.dbDomain,
      instance: dbInstance,
      metadata: { ...metadata },
      logicalSha256,
      holders,
    },
  });
  return {
    plan: {
      kind: "forward-boundary-plan-v3",
      binding,
      profileInstance,
      dbInstance,
      metadata,
      aInventory,
      legacyEntries,
      bWriterImageSha256,
      aMarkerArtifactSha256: hash("e"),
    },
    observations: {
      kind: "forward-boundary-observations-v3",
      binding: structuredClone(binding),
      profileInstance,
      a: { artifact: { ...a }, executor: "legacy-ts", metadata: { ...metadata } },
      b: { artifact: { ...b }, executor: "rust-owner", metadata: { ...metadata } },
      capture: {
        scope: "process-lifecycle-db-authority-and-legacy-relaunch",
        complete: true,
        lostEvents: 0,
        otherAStarts: 0,
        otherBStarts: 0,
        legacyTransportStarts: 0,
        endSeq: 30,
      },
      before: snapshot(1, ["a-backend"], "a-backend", hash("7")),
      retirements: aInventory.map(({ component, process }, index) => ({
        component,
        exit: { ...process },
        status: "verified-exit",
        seq: index + 3,
      })),
      marker: { seq: 2, artifactSha256: hash("e"), sha256: hash("f") },
      boundary: { snapshot: snapshot(6, [], null), writerEpoch: previousEpoch },
      bStart: { seq: 7, process: { instance: "b-backend", imageSha256: bWriterImageSha256 } },
      takeover: {
        snapshot: snapshot(8, ["b-backend"], "b-backend"),
        previousEpoch,
        writerEpoch,
        hydratedLogicalSha256: hash("6"),
        outcome: "committed-cas-and-hydration",
      },
      admission: {
        seq: 9,
        lock: "b-backend",
        dbInstance,
        writerEpoch,
        markerSha256: hash("f"),
        owner: { instance: "b-owner", imageSha256: ownerImage.sha256 },
      },
      relaunches: legacyEntries.map(({ id, callerImageSha256 }, index) => ({
        request: {
          attempt: `attempt-${id}`,
          entry: id,
          seq: 10 + index * 3,
          caller: { instance: `caller-${id}`, imageSha256: callerImageSha256 },
          dbInstance,
        },
        result: {
          attempt: `attempt-${id}`,
          seq: 11 + index * 3,
          outcome: index % 2 ? "refused-by-state-dir-lock" : "refused-by-legacy-fence",
          lock: "b-backend",
          dbInstance,
        },
      })),
    },
  };
}

export type Fixture = ReturnType<typeof fixture>;
