import * as Schema from "effect/Schema";

/** Orca-derived defaults: slightly taller default cells need a little more travel per wheel row. */
export const TERMINAL_SCROLL_SENSITIVITY = { default: 1.15, min: 0.1, max: 10 } as const;
export const TERMINAL_FAST_SCROLL_SENSITIVITY = { default: 5, min: 1, max: 20 } as const;
/** Full-screen TUI wheel speed: mouse reports sent per resolved wheel row. */
export const TERMINAL_TUI_SCROLL_SENSITIVITY = { default: 1, min: 1, max: 10 } as const;

export const TERMINAL_LIGATURE_MODES = ["auto", "on", "off"] as const;
export const TerminalLigatures = Schema.Literals(TERMINAL_LIGATURE_MODES);
export type TerminalLigatures = typeof TerminalLigatures.Type;

const boundedNumber = (bounds: { readonly min: number; readonly max: number }) =>
  Schema.Number.check(Schema.isGreaterThanOrEqualTo(bounds.min)).check(
    Schema.isLessThanOrEqualTo(bounds.max),
  );

/** Terminal scrolling and xterm addon preferences, spread into the client settings schema. */
export const TerminalInteractionSettingsFields = {
  terminalScrollSensitivity: boundedNumber(TERMINAL_SCROLL_SENSITIVITY).pipe(
    Schema.withDecodingDefault(() => TERMINAL_SCROLL_SENSITIVITY.default),
  ),
  terminalFastScrollSensitivity: boundedNumber(TERMINAL_FAST_SCROLL_SENSITIVITY).pipe(
    Schema.withDecodingDefault(() => TERMINAL_FAST_SCROLL_SENSITIVITY.default),
  ),
  terminalTuiScrollSensitivity: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(TERMINAL_TUI_SCROLL_SENSITIVITY.min),
  )
    .check(Schema.isLessThanOrEqualTo(TERMINAL_TUI_SCROLL_SENSITIVITY.max))
    .pipe(Schema.withDecodingDefault(() => TERMINAL_TUI_SCROLL_SENSITIVITY.default)),
  // "auto" enables ligatures for known ligature fonts only.
  terminalLigatures: TerminalLigatures.pipe(Schema.withDecodingDefault(() => "auto" as const)),
  terminalInlineImages: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
};
