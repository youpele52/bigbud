import { isDeepStrictEqual } from "node:util";
import { validateForwardBoundary } from "../forward/check.ts";
import { parseMatrixPlan } from "../matrix/check.ts";
import { object } from "../matrix/input.ts";
import { validateRollbackBoundary } from "../rollback/check.ts";
import { token } from "./evidence.ts";

export function checkRoundTrip(matrixInput: unknown, evidenceInput: unknown) {
  const { cells, scopeReview } = parseMatrixPlan(matrixInput);
  const evidence = object(evidenceInput, ["kind", "scopeReview", "capture", "forward", "rollback"]);
  if (evidence.kind !== "cutover-round-trip-v1" || evidence.scopeReview !== scopeReview) {
    throw new Error("Expected round-trip observations for this matrix scope review");
  }
  const capture = object(evidence.capture, [
    "scope",
    "complete",
    "lostEvents",
    "fenceContinuous",
    "otherAStarts",
    "otherBStarts",
  ]);
  if (
    capture.scope !== "single-forward-rollback-sequence" ||
    capture.complete !== true ||
    capture.lostEvents !== 0 ||
    capture.fenceContinuous !== true ||
    capture.otherAStarts !== 0 ||
    capture.otherBStarts !== 0
  ) {
    throw new Error("Expected one continuous round-trip capture with no unaccounted A/B starts");
  }
  const f = object(evidence.forward, ["plan", "observations"]);
  const r = object(evidence.rollback, ["plan", "observations", "profileInstance"]);
  const forward = validateForwardBoundary(f.plan, f.observations);
  const rollback = validateRollbackBoundary(r.plan, r.observations);
  const { cell } = forward.expected.cell;
  const reviewed = cells.get(cell);
  if (
    reviewed?.disposition !== "required" ||
    !isDeepStrictEqual(reviewed, forward.expected.cell) ||
    !isDeepStrictEqual(reviewed, rollback.expected.cell)
  ) {
    throw new Error("Both boundaries must match the exact reviewed matrix cell and artifacts");
  }
  const { run: handoff } = forward;
  const { run: reversal } = rollback;
  if (
    token(r.profileInstance) !== handoff.profileInstance ||
    reversal.before.db.instance !== handoff.admission.dbInstance ||
    reversal.before.fence !== handoff.admission.fence ||
    !isDeepStrictEqual(rollback.expected.metadata, forward.expected.metadata)
  ) {
    throw new Error("Profile, DB instance, release fence, or schema/migration identity changed");
  }
  if (handoff.captureEnd >= reversal.before.seq) {
    throw new Error("Rollback must start after the forward capture ends in the shared sequence");
  }

  const writer = handoff.bStart.process;
  const owner = handoff.admission.owner;
  const priorA = new Set(handoff.retirements.map(({ exit }) => exit.instance));
  const rollbackRoles = new Map(
    rollback.expected.bInventory.map(({ component, role }) => [component, role]),
  );
  if (
    !reversal.before.db.holders.includes(writer.instance) ||
    !reversal.retirements.some(
      ({ before, component }) =>
        rollbackRoles.get(component) === "launcher" && isDeepStrictEqual(before, writer),
    ) ||
    !reversal.retirements.some(
      ({ before, component }) =>
        rollbackRoles.get(component) === "owner" && isDeepStrictEqual(before, owner),
    ) ||
    reversal.retirements.some(({ before }) => priorA.has(before.instance)) ||
    priorA.has(reversal.aStart.process.instance)
  ) {
    throw new Error("Process lifetimes do not continue from B admission through fresh A startup");
  }
  return {
    status: "round-trip-observations-conform",
    scopeReview,
    slot: reviewed.slot.id,
    cell,
    forwardCaptureEnd: handoff.captureEnd,
    rollbackStart: reversal.before.seq,
    observationsAuthenticated: false,
    rollbackQualified: false,
    s4Accepted: false,
  } as const;
}
