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
  const snapshot = (seq: number, holders: string[]) => ({
    ...structuredClone(handoff.takeover.snapshot),
    seq,
    db: {
      ...structuredClone(handoff.takeover.snapshot.db),
      holders,
      // B may legitimately commit changes after admission.
      logicalSha256: hash("8"),
    },
  });
  const capture = { complete: true, lostEvents: 0, fenceContinuous: true, otherAStarts: 0, otherBStarts: 0 };
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
          kind: "rollback-boundary-plan-v1",
          binding: structuredClone(binding),
          metadata: { ...metadata },
          aImageSha256: a.imageSha256,
          bInventory: processes.map(({ component, role, process }) => ({
            component,
            role,
            imageSha256: process.imageSha256,
          })),
        },
        observations: {
          kind: "rollback-boundary-observations-v1",
          binding: structuredClone(binding),
          a: structuredClone(handoff.a),
          b: structuredClone(handoff.b),
          capture: { ...capture },
          before: snapshot(40, [writer.instance]),
          drained: snapshot(41, [writer.instance]),
          storageRevokedAt: 42,
          retirements: processes.map(({ component, process, seq }) => ({
            component,
            before: { ...process },
            exit: { ...process },
            status: "verified-exit",
            seq,
          })),
          boundary: snapshot(45, []),
          aStart: { seq: 46, process: { ...a } },
          aOpen: snapshot(47, [a.instance]),
        },
      },
    },
  };
}
