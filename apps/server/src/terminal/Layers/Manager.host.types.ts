import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import type * as Effect from "effect/Effect";

import type { PtyHostActivity } from "../Services/PTY.ts";
import type { TerminalHostOutputLedger } from "./Manager.hostScreen.ledger.ts";

/**
 * Per-process host state for a session whose PTY lives in a Rust terminal host (plan S3).
 * Absent for in-process node-pty terminals, so their behavior and snapshots are unchanged.
 */
export interface TerminalSessionHostState {
  /** The `runtimeGeneration` this state belongs to; a restart replaces it. */
  readonly generation: string;
  /** The host `pty_id` (the owner row's resource id). */
  readonly ptyId: string | undefined;
  readonly ledger: TerminalHostOutputLedger;
  /** The host advertises `terminal.screen`: screen items can be sent. */
  readonly screen: boolean;
  /** Screen plus `terminal.query-responder` (§8.9): only restorable views may be parked. */
  restorable: boolean;
  /** The host advertises `terminal.lifecycle`: view state, keep open, notices. */
  readonly lifecycle: boolean;
  activity?: PtyHostActivity | undefined;
  /** ISO time an idle warning closes this terminal, while one is pending. */
  idleClosesAt?: string | undefined;
  /**
   * Direct SSH (M7): the remote foreground program, from remote inspection. It travels with every
   * view-state push; absent for terminals whose host reads its own foreground facts.
   */
  ownerBusyHint?: "busy" | "idle" | "unknown" | undefined;
  /** Last pushed view state, so identical pushes are not repeated. */
  lastViewPush?: string | undefined;
}

export type TerminalSessionInventoryEntry = TerminalSessionInventory["sessions"][number];

/** Manager-wide host hooks shared by the session API, the drain and the layer. */
export interface TerminalHostHub {
  /** Opt-in `lifecycleNotice` subscribers (`includeLifecycle`). */
  readonly subscribeLifecycle: (
    listener: (notice: TerminalLifecycleNotice) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
  readonly publishNotice: (notice: TerminalLifecycleNotice) => Effect.Effect<void>;
  /** Re-sends inventory to `includeInventory` subscribers soon (debounced). */
  readonly refreshInventory: () => void;
  readonly registerInventoryListener: (
    listener: (inventory: TerminalSessionInventory) => Effect.Effect<void>,
  ) => () => void;
  /** Host session started or reattached: push policy and view state. */
  readonly sessionStarted: (threadId: string, terminalId: string) => void;
  /** View state changed for this pane (renderer attach/detach, a view report). */
  readonly viewChanged: (threadId: string, terminalId: string) => void;
}
