import { build, identity, metadata, snapshot } from "../boundary.input.ts";
import { token } from "../cutover/evidence.ts";
import { array, binding, digest, object, positive } from "../matrix/input.ts";

export function requiredBinding(value: unknown) {
  const cell = binding(value);
  if (cell.disposition !== "required") throw new Error("Rollback requires a supported matrix cell");
  return cell;
}

export function plan(value: unknown) {
  const p = object(value, ["kind", "binding", "metadata", "aImageSha256", "bInventory"]);
  if (p.kind !== "rollback-boundary-plan-v1") throw new Error("Expected a rollback boundary plan");
  return {
    cell: requiredBinding(p.binding),
    metadata: metadata(p.metadata),
    aImageSha256: digest(p.aImageSha256),
    bInventory: array(p.bInventory).map((item) => {
      const entry = object(item, ["component", "role", "imageSha256"]);
      if (entry.role !== "launcher" && entry.role !== "owner" && entry.role !== "transport") {
        throw new Error("Invalid B process role");
      }
      return {
        component: token(entry.component),
        role: entry.role,
        imageSha256: digest(entry.imageSha256),
      };
    }),
  };
}

export function observations(value: unknown) {
  const r = object(value, [
    "kind",
    "binding",
    "a",
    "b",
    "capture",
    "before",
    "drained",
    "storageRevokedAt",
    "retirements",
    "boundary",
    "aStart",
    "aOpen",
  ]);
  if (r.kind !== "rollback-boundary-observations-v1") {
    throw new Error("Expected rollback boundary observations, not claim references");
  }
  const capture = object(r.capture, [
    "complete",
    "lostEvents",
    "fenceContinuous",
    "otherBStarts",
    "otherAStarts",
  ]);
  if (
    capture.complete !== true ||
    capture.lostEvents !== 0 ||
    capture.fenceContinuous !== true ||
    capture.otherBStarts !== 0 ||
    capture.otherAStarts !== 0
  ) {
    throw new Error("Uncertain capture, release fence, or overlapping managed launches");
  }
  const start = object(r.aStart, ["seq", "process"]);
  return {
    cell: requiredBinding(r.binding),
    a: build(r.a, "legacy-ts"),
    b: build(r.b, "rust-owner"),
    before: snapshot(r.before),
    drained: snapshot(r.drained),
    storageRevokedAt: positive(r.storageRevokedAt),
    retirements: array(r.retirements).map((item) => {
      const entry = object(item, ["component", "before", "exit", "status", "seq"]);
      if (entry.status !== "verified-exit") throw new Error("Uncertain B process retirement");
      return {
        component: token(entry.component),
        before: identity(entry.before),
        exit: identity(entry.exit),
        seq: positive(entry.seq),
      };
    }),
    boundary: snapshot(r.boundary),
    aStart: { seq: positive(start.seq), process: identity(start.process) },
    aOpen: snapshot(r.aOpen),
  };
}

export type Plan = ReturnType<typeof plan>;
export type Observations = ReturnType<typeof observations>;
