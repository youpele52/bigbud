import { build, identity, metadata, snapshot } from "../boundary.input.ts";
import { token } from "../cutover/evidence.ts";
import { array, binding, digest, object, positive } from "../matrix/input.ts";

function requiredCell(value: unknown) {
  const cell = binding(value);
  if (cell.disposition !== "required")
    throw new Error("Forward handoff requires a supported matrix cell");
  return cell;
}

export function plan(value: unknown) {
  const p = object(value, [
    "kind",
    "binding",
    "profileInstance",
    "dbInstance",
    "metadata",
    "aInventory",
    "legacyEntries",
    "bWriterImageSha256",
    "aMarkerArtifactSha256",
  ]);
  if (p.kind !== "forward-boundary-plan-v3") throw new Error("Expected a v3 forward boundary plan");
  return {
    cell: requiredCell(p.binding),
    profileInstance: token(p.profileInstance),
    dbInstance: token(p.dbInstance),
    metadata: metadata(p.metadata),
    aInventory: array(p.aInventory).map((item) => {
      const entry = object(item, ["component", "role", "process", "dbHolder"]);
      if (entry.role !== "launcher" && entry.role !== "transport")
        throw new Error("Invalid A process role");
      if (typeof entry.dbHolder !== "boolean")
        throw new Error("Expected an A DB holder classification");
      return {
        component: token(entry.component),
        role: entry.role,
        process: identity(entry.process),
        dbHolder: entry.dbHolder,
      };
    }),
    legacyEntries: array(p.legacyEntries).map((item) => {
      const entry = object(item, ["id", "component", "callerImageSha256"]);
      return {
        id: token(entry.id),
        component: token(entry.component),
        callerImageSha256: digest(entry.callerImageSha256),
      };
    }),
    bWriterImageSha256: digest(p.bWriterImageSha256),
    aMarkerArtifactSha256: digest(p.aMarkerArtifactSha256),
  };
}

export function observations(value: unknown) {
  const r = object(value, [
    "kind",
    "binding",
    "profileInstance",
    "a",
    "b",
    "capture",
    "before",
    "retirements",
    "marker",
    "boundary",
    "bStart",
    "takeover",
    "admission",
    "relaunches",
  ]);
  if (r.kind !== "forward-boundary-observations-v3")
    throw new Error("Expected v3 forward observations, not claim references");
  const c = object(r.capture, [
    "scope",
    "complete",
    "lostEvents",
    "otherAStarts",
    "otherBStarts",
    "legacyTransportStarts",
    "endSeq",
  ]);
  if (
    c.scope !== "process-lifecycle-db-authority-and-legacy-relaunch" ||
    c.complete !== true ||
    c.lostEvents !== 0 ||
    c.otherAStarts !== 0 ||
    c.otherBStarts !== 0 ||
    c.legacyTransportStarts !== 0
  ) {
    throw new Error("Uncertain capture or overlapping managed launches");
  }
  const marker = object(r.marker, ["seq", "artifactSha256", "sha256"]);
  const boundary = object(r.boundary, ["snapshot", "writerEpoch"]);
  const start = object(r.bStart, ["seq", "process"]);
  const takeover = object(r.takeover, [
    "snapshot",
    "previousEpoch",
    "writerEpoch",
    "hydratedLogicalSha256",
    "outcome",
  ]);
  if (takeover.outcome !== "committed-cas-and-hydration")
    throw new Error("Expected committed writer epoch CAS and hydration");
  const admission = object(r.admission, [
    "seq",
    "lock",
    "dbInstance",
    "writerEpoch",
    "markerSha256",
    "owner",
  ]);
  return {
    cell: requiredCell(r.binding),
    profileInstance: token(r.profileInstance),
    a: build(r.a, "legacy-ts"),
    b: build(r.b, "rust-owner"),
    captureEnd: positive(c.endSeq),
    before: snapshot(r.before),
    retirements: array(r.retirements).map((item) => {
      const entry = object(item, ["component", "exit", "status", "seq"]);
      if (entry.status !== "verified-exit") throw new Error("Uncertain A process retirement");
      return {
        component: token(entry.component),
        exit: identity(entry.exit),
        seq: positive(entry.seq),
      };
    }),
    marker: {
      seq: positive(marker.seq),
      artifactSha256: digest(marker.artifactSha256),
      sha256: digest(marker.sha256),
    },
    boundary: {
      snapshot: snapshot(boundary.snapshot),
      writerEpoch: boundary.writerEpoch === null ? null : token(boundary.writerEpoch),
    },
    bStart: { seq: positive(start.seq), process: identity(start.process) },
    takeover: {
      snapshot: snapshot(takeover.snapshot),
      previousEpoch: takeover.previousEpoch === null ? null : token(takeover.previousEpoch),
      writerEpoch: token(takeover.writerEpoch),
      hydratedLogicalSha256: digest(takeover.hydratedLogicalSha256),
    },
    admission: {
      seq: positive(admission.seq),
      lock: token(admission.lock),
      dbInstance: token(admission.dbInstance),
      writerEpoch: token(admission.writerEpoch),
      markerSha256: digest(admission.markerSha256),
      owner: identity(admission.owner),
    },
    relaunches: array(r.relaunches).map((item) => {
      const pair = object(item, ["request", "result"]);
      const request = object(pair.request, ["attempt", "entry", "seq", "caller", "dbInstance"]);
      const result = object(pair.result, ["attempt", "seq", "outcome", "lock", "dbInstance"]);
      if (
        result.outcome !== "refused-by-legacy-fence" &&
        result.outcome !== "refused-by-state-dir-lock"
      ) {
        throw new Error("Expected an observed legacy fence or state-dir lock refusal");
      }
      return {
        request: {
          attempt: token(request.attempt),
          entry: token(request.entry),
          seq: positive(request.seq),
          caller: identity(request.caller),
          dbInstance: token(request.dbInstance),
        },
        result: {
          attempt: token(result.attempt),
          seq: positive(result.seq),
          outcome: result.outcome,
          lock: token(result.lock),
          dbInstance: token(result.dbInstance),
        },
      };
    }),
  };
}

export type Plan = ReturnType<typeof plan>;
export type Observations = ReturnType<typeof observations>;
