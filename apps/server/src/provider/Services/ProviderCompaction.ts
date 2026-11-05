import { Schema } from "effect";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";

export const CODEX_COMPACTIONS_KEY = "bigbud.codex.compactions";
export const CODEX_COMPACTION_COMPLETED = "bigbud/manualCompactCompleted";
export const CodexCompactionProof = Schema.Struct({
  nativeThreadId: Schema.NonEmptyString,
  turnId: Schema.NonEmptyString,
  itemId: Schema.NonEmptyString,
});
export type CodexCompactionProof = typeof CodexCompactionProof.Type;
export const CodexCompactionConfirmation = Schema.Struct({
  ...CodexCompactionProof.fields,
  threadId: ThreadId,
  sessionEpoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type CodexCompactionConfirmation = typeof CodexCompactionConfirmation.Type;
const Ledger = Schema.Struct({
  version: Schema.Literal(1),
  threads: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.NonEmptyString)),
});

/** Only explicit live manual-operation proofs qualify; native item-only heuristics are unsafe. */
export function readCodexCompactionProofs(
  payload: unknown,
  nativeThreadId: string,
): Readonly<Record<string, string>> | null {
  if (
    !payload ||
    typeof payload !== "object" ||
    !(CODEX_COMPACTIONS_KEY in payload) ||
    payload[CODEX_COMPACTIONS_KEY] == null
  )
    return {};
  const record = payload[CODEX_COMPACTIONS_KEY];
  if (!Schema.is(Ledger)(record)) return null;
  return record.threads[nativeThreadId] ?? {};
}
