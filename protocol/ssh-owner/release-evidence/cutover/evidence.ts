function shape<K extends string>(value: unknown, label: string, keys: readonly K[]) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error(`Invalid ${label} fields`);
  }
  return value as Record<K, unknown>;
}

function oneOf<const T extends readonly string[]>(value: unknown, options: T): T[number] {
  if (typeof value !== "string" || !options.includes(value)) throw new Error("Invalid enum value");
  return value;
}

export function token(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw new Error("Expected a redacted identifier or image basename");
  }
  return value;
}

export function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("Expected a lowercase SHA-256 digest");
  }
  return value;
}

function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Expected a nonempty array");
  return value.map(parse);
}

function artifact(value: unknown) {
  const fields = shape(value, "artifact", ["id", "sha256"]);
  return { id: token(fields.id), sha256: digest(fields.sha256) };
}

function binding(value: unknown) {
  const fields = shape(value, "binding", ["profile", "os", "arch", "cell", "dbDomain", "schema"]);
  return {
    profile: oneOf(fields.profile, ["D", "V-E", "V-B", "N", "R"]),
    os: oneOf(fields.os, ["darwin", "linux", "win32"]),
    arch: oneOf(fields.arch, ["x64", "arm64"]),
    cell: token(fields.cell),
    dbDomain: token(fields.dbDomain),
    schema: token(fields.schema),
  };
}

const aModes = ["legacy-baseline", "intentional-denial"] as const;
const bModes = ["owner-only", "zero-ssh"] as const;
export const rows = ["X1", "X2", "X3", "X4", "G1", "G2", "G3"] as const;

export function manifest(value: unknown) {
  const fields = shape(value, "manifest", [
    "kind",
    "binding",
    "a",
    "b",
    "ownerSha256",
    "sshSha256",
    "cases",
  ]);
  oneOf(fields.kind, ["cutover-plan-v1"]);
  return {
    binding: binding(fields.binding),
    a: artifact(fields.a),
    b: artifact(fields.b),
    ownerSha256: digest(fields.ownerSha256),
    sshSha256: list(fields.sshSha256, digest),
    cases: list(fields.cases, (item) => {
      const c = shape(item, "case", ["id", "row", "aMode", "bMode", "aOutcome", "bOutcome"]);
      return {
        id: token(c.id),
        row: oneOf(c.row, rows),
        aMode: oneOf(c.aMode, aModes),
        bMode: oneOf(c.bMode, bModes),
        aOutcome: token(c.aOutcome),
        bOutcome: token(c.bOutcome),
      };
    }),
  };
}

function sequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Expected a positive recorder event sequence");
  }
  return value;
}

function image(value: unknown) {
  const p = shape(value, "image", ["seq", "id", "instance", "via", "from", "basename", "sha256"]);
  return {
    seq: sequence(p.seq),
    id: token(p.id),
    instance: token(p.instance),
    via: oneOf(p.via, ["root", "spawn", "exec"]),
    from: p.from === null ? null : token(p.from),
    basename: token(p.basename),
    sha256: digest(p.sha256),
  };
}

export function traces(value: unknown) {
  const fields = shape(value, "trace bundle", ["kind", "runs"]);
  oneOf(fields.kind, ["cutover-process-traces-v1"]);
  return list(fields.runs, (item) => {
    const r = shape(item, "run", [
      "id",
      "caseId",
      "side",
      "binding",
      "artifact",
      "capture",
      "action",
      "owner",
      "images",
    ]);
    const c = shape(r.capture, "capture", ["scope", "complete", "lostEvents"]);
    if (c.scope !== "creation-and-exec-lineage" || c.complete !== true || c.lostEvents !== 0) {
      throw new Error("Incomplete process capture");
    }
    const action = shape(r.action, "action", ["actor", "outcome", "begin", "end"]);
    return {
      id: token(r.id),
      caseId: token(r.caseId),
      side: oneOf(r.side, ["A", "B"]),
      binding: binding(r.binding),
      artifact: artifact(r.artifact),
      actor: token(action.actor),
      outcome: token(action.outcome),
      begin: sequence(action.begin),
      end: sequence(action.end),
      owner: r.owner === null ? null : token(r.owner),
      images: list(r.images, image),
    };
  });
}

export type Manifest = ReturnType<typeof manifest>;
export type Run = ReturnType<typeof traces>[number];
