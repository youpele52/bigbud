import { type PtyProcess } from "../../terminal/Services/PTY";
import { type ThreadShellRunResult } from "../Services/ThreadShellRunner";

export interface HiddenShellSession {
  readonly threadId: string;
  readonly process: PtyProcess;
  pendingControlSequence: string;
  lastKnownCwd: string;
  activeCapture: ActiveCapture | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface ActiveReadyCapture {
  readonly kind: "ready";
  readonly marker: string;
  buffer: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export interface ActiveCommandCapture {
  readonly kind: "command";
  readonly startMarker: string;
  readonly endMarker: string;
  buffer: string;
  output: string;
  sawStart: boolean;
  readonly onOutputChunk: ((chunk: string) => void) | undefined;
  readonly timeout: ReturnType<typeof setTimeout> | null;
  readonly resolve: (result: ThreadShellRunResult) => void;
  readonly reject: (error: Error) => void;
}

export type ActiveCapture = ActiveReadyCapture | ActiveCommandCapture;
