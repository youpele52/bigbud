/**
 * SystemSleepEpochs - the server's single view of "the machine slept".
 *
 * Merges Electron main's power hints, the server's event-loop gap detector and the Rust
 * supervisor's suspended-time clock into sleep epochs. The recovery coordinator classifies
 * turn failures against these epochs and waits on their events.
 *
 * @module SystemSleepEpochs
 */
import type { DesktopLifecycleHint } from "@bigbud/contracts/server/desktopLifecycleHint.ts";
import { ServiceMap } from "effect";
import type { Effect, Option, Stream } from "effect";

import type { SleepEpoch, SleepEvidence } from "../SystemSleepEpochs.logic.ts";

export type SystemSleepEvent =
  /** A new epoch was opened by evidence that the machine woke. */
  | { readonly type: "epoch-ended"; readonly epoch: SleepEpoch }
  /** The desktop reports the network is (back) online. */
  | { readonly type: "network-online"; readonly occurredAtMs: number };

export interface SystemSleepEpochsShape {
  /** Adds evidence from the gap detector or the supervisor clock. */
  readonly recordEvidence: (evidence: SleepEvidence) => Effect.Effect<void>;
  /** Applies one Electron main hint line from the fd 5 pipe. */
  readonly recordDesktopHint: (hint: DesktopLifecycleHint) => Effect.Effect<void>;
  /** Applies one supervisor heartbeat's total suspended time. */
  readonly recordSupervisorSuspendedMillis: (input: {
    readonly suspendedMillis: number;
    readonly observedAtMs: number;
  }) => Effect.Effect<void>;
  readonly latest: Effect.Effect<Option.Option<SleepEpoch>>;
  readonly epochs: Effect.Effect<ReadonlyArray<SleepEpoch>>;
  /** The epoch whose window `[startedAt - 5 s, endedAt + 60 s]` contains `atMs`. */
  readonly epochAt: (atMs: number) => Effect.Effect<Option.Option<SleepEpoch>>;
  readonly isWithinSleepWindow: (atMs: number) => Effect.Effect<boolean>;
  /** Latest desktop network state, or null when no desktop hint said so. */
  readonly networkOnline: Effect.Effect<boolean | null>;
  /** Each subscriber receives every event published after it subscribed. */
  readonly events: Stream.Stream<SystemSleepEvent>;
}

export class SystemSleepEpochs extends ServiceMap.Service<
  SystemSleepEpochs,
  SystemSleepEpochsShape
>()("bigbud/system-sleep/Services/SystemSleepEpochs") {}
