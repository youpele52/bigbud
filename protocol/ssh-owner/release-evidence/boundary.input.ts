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

export function snapshot(value: unknown) {
  const frame = object(value, ["seq", "fence", "db"]);
  const db = object(frame.db, ["domain", "instance", "metadata", "logicalSha256", "holders"]);
  if (!Array.isArray(db.holders)) throw new Error("Expected a DB holder array");
  return {
    seq: positive(frame.seq),
    fence: token(frame.fence),
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
