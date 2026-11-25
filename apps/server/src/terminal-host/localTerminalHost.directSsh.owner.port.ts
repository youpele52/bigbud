import type { PtyProcess } from "../terminal/Services/PTY.ts";

/** Only an already-authorized product pane can request the owner's managed login terminal. */
export interface NativeDirectSshTerminalOpen {
  readonly pane: { readonly threadId: string; readonly terminalId: string };
  readonly targetId: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
}

/** Opaque lease within an authenticated owner epoch and target generation. */
export interface NativeDirectSshTerminalBinding {
  readonly targetId: string;
  readonly ownerEpoch: string;
  readonly targetGeneration: string;
  readonly leaseId: string;
}

export interface NativeDirectSshTerminalAttachment {
  readonly binding: NativeDirectSshTerminalBinding;
  /** Set only for an exact, gap-free replay from byte sequence zero. */
  readonly recoveredHistoryFromStart?: true;
  /** Detach retires this observer only. The owner keeps terminal state, output and idle policy. */
  readonly process: PtyProcess & { readonly detach: () => void };
}

export interface NativeDirectSshTerminalStatus {
  readonly binding: NativeDirectSshTerminalBinding;
  /** Exited is final for this lease: the local SSH process was reaped, not the remote shell or job. */
  readonly state: "live" | "exited" | "unknown";
}

export interface NativeDirectSshTerminalOwner {
  /** No child may start here. Prepare a unique lease bound to this intent; unused grants expire. */
  readonly prepareOpen: (
    input: NativeDirectSshTerminalOpen,
    signal: AbortSignal,
  ) => Promise<NativeDirectSshTerminalBinding>;
  /** The sole spawn operation; the backend has already recorded the exact lease durably. */
  readonly open: (
    input: NativeDirectSshTerminalOpen,
    binding: NativeDirectSshTerminalBinding,
    signal: AbortSignal,
  ) => Promise<NativeDirectSshTerminalAttachment>;
  /** Lookup/attach only, with a bounded cold snapshot; no create or reconnect to the host. */
  readonly reattach: (
    binding: NativeDirectSshTerminalBinding,
    signal: AbortSignal,
  ) => Promise<NativeDirectSshTerminalAttachment>;
  readonly status: (
    binding: NativeDirectSshTerminalBinding,
    signal: AbortSignal,
  ) => Promise<NativeDirectSshTerminalStatus>;
  /** Confirmed exit must fence a delayed Open of this lease, not merely find its PTY absent. */
  readonly close: (
    binding: NativeDirectSshTerminalBinding,
    signal: AbortSignal,
  ) => Promise<NativeDirectSshTerminalStatus>;
}
