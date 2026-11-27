import { token } from "./cutover/evidence.ts";
import { digest, image, object, positive } from "./matrix/input.ts";

export function metadata(value: unknown) {
  const fields = object(value, ["schemaCeiling", "schemaSha256", "migration", "migrationSha256"]);
  return {
    schemaCeiling: positive(fields.schemaCeiling),
    schemaSha256: digest(fields.schemaSha256),
    migration: positive(fields.migration),
    migrationSha256: digest(fields.migrationSha256),
  };
}

export function build(value: unknown, executor: "legacy-ts" | "rust-owner") {
  const fields = object(value, ["artifact", "executor", "metadata"]);
  if (fields.executor !== executor) throw new Error(`Expected ${executor} artifact metadata`);
  return { artifact: image(fields.artifact), metadata: metadata(fields.metadata) };
}

/** `lock` is the process lifetime holding `<stateDir>/backend.lock`, or `null` while free. */
export function snapshot(value: unknown) {
  const frame = object(value, ["seq", "lock", "db"]);
  const db = object(frame.db, ["domain", "instance", "metadata", "logicalSha256", "holders"]);
  if (!Array.isArray(db.holders)) throw new Error("Expected a DB holder array");
  return {
    seq: positive(frame.seq),
    lock: frame.lock === null ? null : token(frame.lock),
    db: {
      domain: token(db.domain),
      instance: token(db.instance),
      metadata: metadata(db.metadata),
      logicalSha256: digest(db.logicalSha256),
      holders: (db.holders as unknown[]).map(token),
    },
  };
}

export function identity(value: unknown) {
  const fields = object(value, ["instance", "imageSha256"]);
  return { instance: token(fields.instance), imageSha256: digest(fields.imageSha256) };
}

/** The owner's own drain shutdown report (reply 108), as answered and as recorded. */
export function ownerShutdown(value: unknown) {
  const fields = object(value, ["masters", "leases", "attachCleared"]);
  for (const count of [fields.masters, fields.leases]) {
    if (!Number.isSafeInteger(count) || (count as number) < 0)
      throw new Error("Expected owner shutdown counts");
  }
  if (typeof fields.attachCleared !== "boolean")
    throw new Error("Expected the owner's attach-record outcome");
  return {
    masters: fields.masters as number,
    leases: fields.leases as number,
    attachCleared: fields.attachCleared,
  };
}
