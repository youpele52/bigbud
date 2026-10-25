/** Kinds of shared resources that force a server test file into the serial group. */
export type TouchKind = "process" | "pty" | "worker" | "sqlite" | "network" | "filesystem";

export interface Touch {
  readonly kind: TouchKind;
  readonly detail: string;
}

export type ReportTouch = (touch: Touch) => void;

/** One line of the probe output written by the guard in probe mode. */
export interface ProbeRecord {
  /** Test file path relative to the server root, POSIX separators. */
  readonly file: string;
  readonly touches: ReadonlyArray<Touch>;
}

/** Set by the probe run; the guard then records touches instead of failing. */
export const PROBE_OUTPUT_ENV = "BIGBUD_TEST_GROUP_PROBE_OUTPUT";
