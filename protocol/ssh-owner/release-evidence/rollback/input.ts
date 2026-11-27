import { build, identity, metadata, ownerShutdown, snapshot } from "../boundary.input.ts";
import { token } from "../cutover/evidence.ts";
import { array, binding, digest, object, positive } from "../matrix/input.ts";

export function requiredBinding(value: unknown) {
  const cell = binding(value);
  if (cell.disposition !== "required") throw new Error("Rollback requires a supported matrix cell");
  return cell;
}

export function plan(value: unknown) {
  const p = object(value, [
    "kind",
    "binding",
    "metadata",
    "aImageSha256",
    "bInventory",
    "bRecordArtifactSha256",
  ]);
  if (p.kind !== "rollback-boundary-plan-v2")
    throw new Error("Expected a v2 rollback boundary plan");
  return {
    cell: requiredBinding(p.binding),
    metadata: metadata(p.metadata),
    aImageSha256: digest(p.aImageSha256),
    bRecordArtifactSha256: digest(p.bRecordArtifactSha256),
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
    "drain",
    "drained",
    "retirements",
    "boundary",
    "aStart",
    "aOpen",
  ]);
  if (r.kind !== "rollback-boundary-observations-v2") {
    throw new Error("Expected v2 rollback boundary observations, not claim references");
  }
  const capture = object(r.capture, ["complete", "lostEvents", "otherBStarts", "otherAStarts"]);
  if (
    capture.complete !== true ||
    capture.lostEvents !== 0 ||
    capture.otherBStarts !== 0 ||
    capture.otherAStarts !== 0
  ) {
    throw new Error("Uncertain capture or overlapping managed launches");
  }
  const drain = object(r.drain, ["seq", "status", "owner", "record", "legacyMarkerSha256"]);
  if (drain.status !== "drained") throw new Error("Expected B's answered drain");
  const record = object(drain.record, ["artifactSha256", "ownerEpoch", "owner"]);
  const marker = object(drain.legacyMarkerSha256, ["before", "drained"]);
  const start = object(r.aStart, ["seq", "process"]);
  return {
    cell: requiredBinding(r.binding),
    a: build(r.a, "legacy-ts"),
    b: build(r.b, "rust-owner"),
    before: snapshot(r.before),
    drain: {
      seq: positive(drain.seq),
      owner: ownerShutdown(drain.owner),
      record: {
        artifactSha256: digest(record.artifactSha256),
        ownerEpoch: record.ownerEpoch === null ? null : token(record.ownerEpoch),
        owner: record.owner === null ? null : ownerShutdown(record.owner),
      },
      legacyMarkerSha256: { before: digest(marker.before), drained: digest(marker.drained) },
    },
    drained: snapshot(r.drained),
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
