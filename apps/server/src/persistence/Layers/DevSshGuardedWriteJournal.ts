import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { isSshOwnerDevFixtureSelected } from "../../ssh/sshOwnerSelection.ts";

const maxRecords = 1_024;
const maxWriteBytes = 512 * 1_024;

export interface DevSshGuardedWriteBinding {
  readonly operationId: string;
  readonly profileId: string;
  readonly targetId: string;
  readonly cwd: string;
  readonly relativePath: string;
  readonly baseSha256: string;
  readonly attemptedSha256: string;
  readonly byteSize: number;
}

export type DevSshGuardedWriteReceipt =
  | { readonly kind: "saved"; readonly resultSha256: string }
  | { readonly kind: "conflict"; readonly currentSha256: string | null }
  | { readonly kind: "terminal" | "unknown" };

interface JournalRow extends DevSshGuardedWriteBinding {
  readonly receiptKind: DevSshGuardedWriteReceipt["kind"] | null;
  readonly receiptSha256: string | null;
}

type Failure = { readonly kind: "bindingMismatch" };
type Existing = {
  readonly kind: "existing";
  /** No receipt means dispatch may or may not have happened. Neither state permits replay. */
  readonly receipt: DevSshGuardedWriteReceipt | null;
};
type Lookup = Existing | Failure | { readonly kind: "missing" };
type Claim = Existing | Failure | { readonly kind: "claimed" | "capacityReached" };
type Settlement = Existing | Failure | { readonly kind: "recorded" | "missing" };

class DevSshGuardedWriteJournalError extends Error {
  override readonly name = "DevSshGuardedWriteJournalError";
}

const isSha256 = (value: string) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isText = (value: string, maxBytes: number) => {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > maxBytes ||
    value.includes("\0")
  ) {
    return false;
  }
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= maxBytes && bytes.toString("utf8") === value;
};

const isBinding = (binding: DevSshGuardedWriteBinding) =>
  isText(binding.operationId, 128) &&
  binding.operationId.trim() === binding.operationId &&
  isText(binding.profileId, 256) &&
  isText(binding.targetId, 256) &&
  binding.targetId.startsWith("ssh:") &&
  isText(binding.cwd, 4_096) &&
  isText(binding.relativePath, 4_096) &&
  isSha256(binding.baseSha256) &&
  isSha256(binding.attemptedSha256) &&
  Number.isInteger(binding.byteSize) &&
  binding.byteSize >= 0 &&
  binding.byteSize <= maxWriteBytes;

const matches = (row: JournalRow, binding: DevSshGuardedWriteBinding) =>
  row.profileId === binding.profileId &&
  row.targetId === binding.targetId &&
  row.cwd === binding.cwd &&
  row.relativePath === binding.relativePath &&
  row.baseSha256 === binding.baseSha256 &&
  row.attemptedSha256 === binding.attemptedSha256 &&
  row.byteSize === binding.byteSize;

const ensureAutocommit = Effect.fn("ensureDevSshGuardedWriteJournalAutocommit")(function* () {
  if (!isSshOwnerDevFixtureSelected()) {
    return yield* Effect.fail(new DevSshGuardedWriteJournalError("Source-dev SSH owner required"));
  }
  // A savepoint inside an ambient transaction cannot authorize an external dispatch: the
  // outer transaction could still roll back after the caller launches the remote write.
  const transaction = yield* Effect.serviceOption(SqlClient.TransactionConnection);
  if (transaction._tag === "Some") {
    return yield* Effect.fail(new DevSshGuardedWriteJournalError("Journal requires autocommit"));
  }
});

const checkedBinding = (input: DevSshGuardedWriteBinding) =>
  Effect.gen(function* () {
    yield* ensureAutocommit();
    const binding = { ...input };
    if (!isBinding(binding)) {
      return yield* Effect.fail(new DevSshGuardedWriteJournalError("Invalid write binding"));
    }
    return binding;
  });

const readReceipt = (row: JournalRow): DevSshGuardedWriteReceipt | null => {
  switch (row.receiptKind) {
    case null:
      return null;
    case "saved":
      return { kind: "saved", resultSha256: row.attemptedSha256 };
    case "conflict":
      return { kind: "conflict", currentSha256: row.receiptSha256 };
    case "terminal":
    case "unknown":
      return { kind: row.receiptKind };
  }
};

/**
 * Explicit schema bootstrap for an already-selected source-dev owner only. Use the same durable
 * dev database across restarts, and do not run journal operations in raw SQLite transactions.
 * The caller owns the database and its sync settings; use FULL if power-loss durability is needed.
 */
export const initializeDevSshGuardedWriteJournal = Effect.fn("initializeDevSshGuardedWriteJournal")(
  function* (sql: SqlClient.SqlClient, capacity = maxRecords) {
    yield* ensureAutocommit();
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > maxRecords) {
      return yield* Effect.fail(new DevSshGuardedWriteJournalError("Invalid journal capacity"));
    }
    yield* sql`CREATE TABLE IF NOT EXISTS dev_ssh_guarded_write_journal (
      operation_id TEXT PRIMARY KEY NOT NULL,
      profile_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      base_sha256 TEXT NOT NULL,
      attempted_sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND 524288),
      receipt_kind TEXT CHECK (receipt_kind IN ('saved', 'conflict', 'terminal', 'unknown')),
      receipt_sha256 TEXT CHECK (receipt_kind IS 'conflict' OR receipt_sha256 IS NULL)
    ) STRICT`;

    const bindingValues = (binding: DevSshGuardedWriteBinding) =>
      sql`${binding.profileId}, ${binding.targetId}, ${binding.cwd}, ${binding.relativePath},
        ${binding.baseSha256}, ${binding.attemptedSha256}, ${binding.byteSize}`;

    const lookupBinding = Effect.fn("lookupDevSshGuardedWriteBinding")(function* (
      binding: DevSshGuardedWriteBinding,
    ): Effect.fn.Return<Lookup, SqlError> {
      const [row] = yield* sql<JournalRow>`SELECT operation_id AS operationId,
        profile_id AS profileId, target_id AS targetId, cwd, relative_path AS relativePath,
        base_sha256 AS baseSha256, attempted_sha256 AS attemptedSha256, byte_size AS byteSize,
        receipt_kind AS receiptKind, receipt_sha256 AS receiptSha256
        FROM dev_ssh_guarded_write_journal WHERE operation_id = ${binding.operationId}`.pipe(
        Effect.provideService(SqlClient.SafeIntegers, false),
      );
      if (!row) return { kind: "missing" };
      if (!matches(row, binding)) return { kind: "bindingMismatch" };
      return { kind: "existing", receipt: readReceipt(row) };
    });

    const lookup = Effect.fn("lookupDevSshGuardedWrite")(function* (
      input: DevSshGuardedWriteBinding,
    ) {
      return yield* lookupBinding(yield* checkedBinding(input));
    });

    const claim = Effect.fn("claimDevSshGuardedWrite")(function* (
      input: DevSshGuardedWriteBinding,
    ): Effect.fn.Return<Claim, SqlError | DevSshGuardedWriteJournalError> {
      const binding = yield* checkedBinding(input);
      // One autocommitted statement serializes capacity and uniqueness across connections.
      // Only a fresh insert authorizes dispatch. No expiry, deletion, or re-arming.
      const [inserted] = yield* sql`INSERT INTO dev_ssh_guarded_write_journal (
        operation_id, profile_id, target_id, cwd, relative_path, base_sha256, attempted_sha256,
        byte_size
      ) SELECT ${binding.operationId}, ${bindingValues(binding)}
        WHERE (SELECT COUNT(*) FROM dev_ssh_guarded_write_journal) < ${capacity}
        ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id`;
      if (inserted) return { kind: "claimed" };
      const previous = yield* lookupBinding(binding);
      return previous.kind === "missing" ? { kind: "capacityReached" } : previous;
    });

    const recordReceipt = Effect.fn("recordDevSshGuardedWriteReceipt")(function* (
      input: DevSshGuardedWriteBinding,
      receipt: DevSshGuardedWriteReceipt,
    ): Effect.fn.Return<Settlement, SqlError | DevSshGuardedWriteJournalError> {
      const binding = yield* checkedBinding(input);
      const kind = receipt.kind;
      const sha256 = kind === "conflict" ? receipt.currentSha256 : null;
      if (
        (kind !== "saved" && kind !== "conflict" && kind !== "terminal" && kind !== "unknown") ||
        (kind === "saved" && receipt.resultSha256 !== binding.attemptedSha256) ||
        (kind === "conflict" && sha256 !== null && !isSha256(sha256))
      ) {
        return yield* Effect.fail(new DevSshGuardedWriteJournalError("Invalid write receipt"));
      }
      // A saved receipt uses the already-bound attempted SHA, after corroborating it above.
      const [updated] = yield* sql`UPDATE dev_ssh_guarded_write_journal
        SET receipt_kind = ${kind}, receipt_sha256 = ${sha256}
        WHERE operation_id = ${binding.operationId} AND receipt_kind IS NULL
          AND (profile_id, target_id, cwd, relative_path, base_sha256, attempted_sha256, byte_size)
            = (${bindingValues(binding)})
        RETURNING operation_id`;
      return updated ? { kind: "recorded" } : yield* lookupBinding(binding);
    });

    return { claim, lookup, recordReceipt };
  },
);
