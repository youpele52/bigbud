import { fixture as forwardFixture, hash } from "../forward/check.fixture.ts";
import { fixtures as matrixFixtures } from "../matrix/check.fixture.ts";

export function fixture() {
  const forward = forwardFixture();
  const { observations: handoff, plan } = forward;
  const { binding, metadata, profileInstance } = plan;
  const { plan: matrix } = matrixFixtures();
  for (const cell of matrix.cells) {
    if (cell.identity) {
      cell.identity.a.build = binding.identity.a.build;
      cell.identity.b.build = binding.identity.b.build;
    }
  }
  matrix.cells.splice(
    matrix.cells.findIndex(({ slot }) => slot === binding.slot),
    1,
    structuredClone(binding),
  );
  const writer = handoff.bStart.process;
  const owner = handoff.admission.owner;
  const processes = [
    { component: "backend", role: "launcher", process: writer, seq: 44 },
    { component: "owner", role: "owner", process: owner, seq: 43 },
  ];
  const a = { instance: "reopened-a", imageSha256: plan.aInventory[0]!.process.imageSha256 };
  const snapshot = (seq: number, holders: string[], lock: string | null) => ({
    ...structuredClone(handoff.takeover.snapshot),
    seq,
    lock,
    db: {
      ...structuredClone(handoff.takeover.snapshot.db),
      holders,
      // B may legitimately commit changes after admission.
      logicalSha256: hash("8"),
    },
  });
  const capture = { complete: true, lostEvents: 0, otherAStarts: 0, otherBStarts: 0 };
  const shutdown = { masters: 1, leases: 0, attachCleared: true };
  return {
    matrix,
    evidence: {
      kind: "cutover-round-trip-v1",
      scopeReview: matrix.scopeReview,
      capture: { scope: "single-forward-rollback-sequence", ...capture },
      forward,
      rollback: {
        profileInstance,
        plan: {
          kind: "rollback-boundary-plan-v2",
          binding: structuredClone(binding),
          metadata: { ...metadata },
          aImageSha256: a.imageSha256,
          bRecordArtifactSha256: hash("7"),
          bInventory: processes.map(({ component, role, process }) => ({
            component,
            role,
            imageSha256: process.imageSha256,
          })),
        },
        observations: {
          kind: "rollback-boundary-observations-v2",
          binding: structuredClone(binding),
          a: structuredClone(handoff.a),
          b: structuredClone(handoff.b),
          capture: { ...capture },
          before: snapshot(40, [writer.instance], writer.instance),
          drain: {
            seq: 41,
            status: "drained",
            owner: { ...shutdown },
            record: { artifactSha256: hash("7"), ownerEpoch: "b-owner-epoch", owner: shutdown },
            legacyMarkerSha256: { before: hash("f"), drained: hash("f") },
          },
          drained: snapshot(42, [writer.instance], writer.instance),
          retirements: processes.map(({ component, process, seq }) => ({
            component,
            before: { ...process },
            exit: { ...process },
            status: "verified-exit",
            seq,
          })),
          boundary: snapshot(45, [], null),
          aStart: { seq: 46, process: { ...a } },
          aOpen: snapshot(47, [a.instance], a.instance),
        },
      },
    },
  };
}
