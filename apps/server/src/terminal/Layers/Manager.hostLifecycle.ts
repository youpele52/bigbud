/**
 * Host lifecycle facts for host-backed sessions (plan §8.5, §11.2, §11.3): activity, idle
 * warnings and host-initiated closes become session state and `lifecycleNotice` items for
 * `includeLifecycle` subscribers. In-process terminals never get host state.
 *
 * @module Manager.hostLifecycle
 */
import {
  TERMINAL_HOST_CLOSED_REASONS,
  type TerminalEndedReason,
} from "@bigbud/contracts/workspace/terminal.limit.ts";
import type {
  TerminalLifecycleNotice,
  TerminalLifecycleNoticeKind,
} from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import * as Effect from "effect/Effect";

import type { PtyHostLifecycleNotice, PtyProcess } from "../Services/PTY.ts";
import type { TerminalHostHub, TerminalSessionHostState } from "./Manager.host.types.ts";
import { TerminalHostOutputLedger } from "./Manager.hostScreen.ledger.ts";
import type { TerminalSessionState } from "./Manager.types.ts";

/** Wire notice kinds (`pty_lifecycle.proto`) and what each means for the session. */
const NOTICE_KINDS: Readonly<
  Record<string, { kind: TerminalLifecycleNoticeKind; ended?: TerminalEndedReason }>
> = {
  idle_warning: { kind: "idleWarning" },
  idle_warning_cleared: { kind: "idleWarningCleared" },
  idle_closed: { kind: "idleClosed", ended: "idle" },
  pressure_closed: { kind: "pressureClosed", ended: "memory" },
  pressure_no_candidate: { kind: "pressureNoCandidate" },
  limit_closed: { kind: "limitClosed", ended: "limit" },
  orphan_closed: { kind: "orphanClosed", ended: "orphan" },
  quit_closed: { kind: "quitClosed", ended: "quit" },
  model_invalid: { kind: "modelInvalid" },
  spool_degraded: { kind: "spoolDegraded" },
};

const isoOf = (ms: number) => new Date(ms > 0 ? ms : Date.now()).toISOString();

/** Maps one host notice; unknown kinds (a newer host) are ignored, never forwarded. */
export function terminalLifecycleNoticeFromHost(
  notice: PtyHostLifecycleNotice & { readonly ptyId?: string },
  pane: { readonly threadId: string; readonly terminalId: string } | undefined,
): { notice: TerminalLifecycleNotice; ended: TerminalEndedReason | undefined } | undefined {
  const mapped = NOTICE_KINDS[notice.kind];
  if (!mapped) return undefined;
  const id = `host:${notice.ptyId ?? ""}:${notice.noticeId}`.slice(0, 128);
  return {
    ended: mapped.ended,
    notice: {
      type: "lifecycleNotice",
      noticeId: id,
      kind: mapped.kind,
      ...(pane ? { threadId: pane.threadId, terminalId: pane.terminalId } : {}),
      ...(mapped.kind === "idleWarning" && notice.closesAtMs > 0
        ? { closesAt: isoOf(notice.closesAtMs) }
        : {}),
      createdAt: isoOf(notice.occurredAtMs),
    },
  };
}

/**
 * Host state for a freshly spawned or reattached process, installed before its data listener
 * (adapters may emit during registration). Undefined for processes without host capabilities.
 */
export function beginTerminalHostSession(
  session: TerminalSessionState,
  process: PtyProcess,
): { state: TerminalSessionHostState; dispose: () => void } | undefined {
  if (!process.onSequencedData) return undefined;
  const screen = process.screen?.capabilities();
  const lifecycle = process.lifecycle?.capabilities();
  if (!screen?.screen && !lifecycle?.lifecycle) return undefined;
  const ledger = new TerminalHostOutputLedger();
  const state: TerminalSessionHostState = {
    generation: session.runtimeGeneration,
    ptyId: process.remoteResourceId,
    ledger,
    screen: screen?.screen === true,
    restorable: screen?.screen === true && screen.queryResponder === true,
    lifecycle: lifecycle?.lifecycle === true,
  };
  const unsubscribe = process.onSequencedData((event) => ledger.noteSequence(event.sequence));
  return { state, dispose: unsubscribe };
}

/** Activity and notices of one host process; returns the disposer. */
export function bindTerminalHostLifecycle(input: {
  readonly hub: TerminalHostHub;
  readonly session: TerminalSessionState;
  readonly process: PtyProcess;
  readonly runFork: (effect: Effect.Effect<void>) => void;
}): () => void {
  const { hub, session, process } = input;
  const host = session.host;
  const control = process.lifecycle;
  if (!host?.lifecycle || !control) return () => undefined;
  const current = () => session.host === host && session.process === process;
  const removeActivity = control.onActivity((activity) => {
    if (!current()) return;
    const busyChanged = host.activity?.sidebarBusy !== activity.sidebarBusy;
    host.activity = activity;
    if (busyChanged) hub.refreshInventory();
  });
  const removeNotice = control.onNotice((notice) => {
    if (session.host !== host) return;
    const mapped = terminalLifecycleNoticeFromHost(
      { ...notice, ...(host.ptyId ? { ptyId: host.ptyId } : {}) },
      session,
    );
    if (!mapped) return;
    applyTerminalHostNotice(session, host, mapped.notice, mapped.ended);
    hub.refreshInventory();
    input.runFork(hub.publishNotice(mapped.notice));
  });
  return () => {
    removeActivity();
    removeNotice();
  };
}

export function applyTerminalHostNotice(
  session: TerminalSessionState,
  host: TerminalSessionHostState,
  notice: TerminalLifecycleNotice,
  ended: TerminalEndedReason | undefined,
): void {
  if (notice.kind === "idleWarning") host.idleClosesAt = notice.closesAt;
  else if (notice.kind === "idleWarningCleared") host.idleClosesAt = undefined;
  else if (notice.kind === "modelInvalid") host.restorable = false;
  if (ended) {
    host.idleClosesAt = undefined;
    session.endedReason = ended;
  }
}

/** The process ended without a verified exit because its host went away (§14 host crash). */
export function terminalHostLostNotice(session: TerminalSessionState): TerminalLifecycleNotice {
  return {
    type: "lifecycleNotice",
    noticeId: `host-lost:${session.runtimeGeneration}`.slice(0, 128),
    kind: "hostLost",
    threadId: session.threadId,
    terminalId: session.terminalId,
    createdAt: new Date().toISOString(),
  };
}

/** The host closed this ended session (idle, memory, limit, orphan); it must never respawn. */
export function terminalHostClosedSession(session: TerminalSessionState): boolean {
  return (
    !session.process &&
    session.status !== "running" &&
    session.endedReason !== undefined &&
    TERMINAL_HOST_CLOSED_REASONS.includes(session.endedReason)
  );
}

/** Snapshot fields for host sessions; in-process sessions keep today's snapshot unchanged. */
export function terminalHostSnapshotFields(session: TerminalSessionState) {
  const host = session.host;
  return {
    ...(host?.screen ? { screenSource: "host" as const } : {}),
    // An ended terminal's view is never parked; only a live screen model can restore it.
    ...(host ? { restorable: host.restorable && session.status === "running" } : {}),
    ...(session.endedReason && session.status !== "running"
      ? { endedReason: session.endedReason }
      : {}),
  };
}

export const publishTerminalHostNotice = (
  hub: TerminalHostHub | undefined,
  notice: TerminalLifecycleNotice,
): Effect.Effect<void> => (hub ? hub.publishNotice(notice) : Effect.void);
