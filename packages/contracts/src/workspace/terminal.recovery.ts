import * as Schema from "effect/Schema";

// UTF-16 code units, not UTF-8 transport bytes. JSON escaping can use six bytes per unit.
export const TERMINAL_RECOVERY_ANSI_MAX_CHARS = 1_048_576;
export const TERMINAL_RECOVERY_TAIL_MAX_CHARS = 16_384;

const Generation = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(128));
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Cols = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(1000),
);
const Rows = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);
export const TerminalRecoveryCursor = Schema.Struct({ generation: Generation, sequence: Sequence });
export type TerminalRecoveryCursor = typeof TerminalRecoveryCursor.Type;
export const TerminalRecoveryInput = Schema.Struct({
  threadId: Generation,
  terminalId: Generation,
  expectedGeneration: Generation,
  after: Schema.optional(TerminalRecoveryCursor),
});
export type TerminalRecoveryInput = typeof TerminalRecoveryInput.Type;
const Record = Schema.Union([
  Schema.Struct({
    ...TerminalRecoveryCursor.fields,
    type: Schema.Literal("output"),
    data: Schema.String.check(Schema.isMaxLength(32768)),
  }),
  Schema.Struct({
    ...TerminalRecoveryCursor.fields,
    type: Schema.Literal("resize"),
    cols: Cols,
    rows: Rows,
  }),
]);
export const TerminalRecoveryResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    frame: Schema.Struct({
      ...TerminalRecoveryCursor.fields,
      cols: Cols,
      rows: Rows,
      ansi: Schema.String.check(Schema.isMaxLength(TERMINAL_RECOVERY_ANSI_MAX_CHARS)),
      pendingEscapeTail: Schema.String.check(Schema.isMaxLength(TERMINAL_RECOVERY_TAIL_MAX_CHARS)),
      scrollbackRows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
        Schema.isLessThanOrEqualTo(1000),
      ),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("suffix"),
    through: TerminalRecoveryCursor,
    records: Schema.Array(Record).check(Schema.isMaxLength(4096)),
  }),
  Schema.Struct({ type: Schema.Literal("snapshot-required"), through: TerminalRecoveryCursor }),
  Schema.Struct({
    type: Schema.Literal("unavailable"),
    reason: Schema.String.check(Schema.isMaxLength(256)),
  }),
]);
export type TerminalRecoveryResult = typeof TerminalRecoveryResult.Type;
