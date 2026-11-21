/**
 * Host policy and view state (plan §8.7, §8.9, §14). The server opts the host in on every
 * (re)connect with the lifecycle policy, and tells it per PTY whether a view shows it and
 * whether a renderer is attached, so the host's idle rule and query responder follow the UI.
 *
 * @module Manager.hostPolicy
 */
import { TERMINAL_LIVE_LIMIT_DEFAULT } from "@bigbud/contracts/workspace/terminal.limit.ts";

import type { RemoteAgentHostPolicy } from "../../remote-agent/remoteAgentProtocol.ptyLifecycle.ts";
import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import type { PtyViewState } from "../Services/PTY.ts";
import type { TerminalSessionHostState } from "./Manager.host.types.ts";
import type { TerminalSessionState } from "./Manager.types.ts";

/** Plan §23 constants: idle 10 minutes with a 60 s warning, orphan grace 10 minutes. */
export const TERMINAL_HOST_IDLE_CLOSE_MS = 600_000;
export const TERMINAL_HOST_IDLE_WARNING_MS = 60_000;
export const TERMINAL_HOST_ORPHAN_CLOSE_MS = 600_000;

/**
 * Keep mode leaves orphaned terminals running (orphan 0 means keep); idle close still applies.
 * Zero memory thresholds mean the host defaults. The latest revision wins across owners.
 */
export function terminalHostPolicy(input: {
  readonly keepRunningAfterQuit: boolean;
  readonly revision: number;
}): RemoteAgentHostPolicy {
  return {
    lifecycleEnabled: true,
    idleCloseMs: TERMINAL_HOST_IDLE_CLOSE_MS,
    idleWarningMs: TERMINAL_HOST_IDLE_WARNING_MS,
    maxLivePtys: TERMINAL_LIVE_LIMIT_DEFAULT,
    orphanCloseMs: input.keepRunningAfterQuit ? 0 : TERMINAL_HOST_ORPHAN_CLOSE_MS,
    memoryPressureEnabled: true,
    memoryAvailableLowPercent: 0,
    memoryAvailableCriticalPercent: 0,
    hostRssLowBytes: 0,
    hostRssCriticalBytes: 0,
    terminalRssLowPercent: 0,
    terminalRssCriticalPercent: 0,
    revision: input.revision,
  };
}

/** Pushes the policy whenever the admitted host connection or the keep setting changes. */
export class TerminalHostPolicyPusher {
  private pushedKey: string | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private revision = 0;

  constructor(
    private readonly runtime: () => OwnedPtyRuntime | undefined,
    private readonly keepRunningAfterQuit: () => boolean,
    private readonly log: (message: string, detail: Record<string, unknown>) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Coalesced: one push in flight, re-checked once more if asked again meanwhile. */
  ensure(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        void this.ensure();
      }
    });
    return this.running;
  }

  private async run(): Promise<void> {
    const generations = this.runtime()?.hostGenerations;
    if (!generations) return;
    try {
      const admitted = await generations.admittedKey();
      if (!admitted) return;
      const keep = this.keepRunningAfterQuit();
      const key = `${admitted}:${keep ? "keep" : "close"}`;
      if (key === this.pushedKey) return;
      this.revision = Math.max(this.revision + 1, this.now());
      await generations.updatePolicy(
        terminalHostPolicy({ keepRunningAfterQuit: keep, revision: this.revision }),
      );
      this.pushedKey = key;
    } catch (cause) {
      this.log("terminal host policy push failed", { cause: String(cause) });
    }
  }
}

/** Full view state for one host PTY; the acked sequence travels only with a detach (F8). */
export function terminalHostViewState(input: {
  readonly visible: boolean;
  readonly renderers: number;
  readonly ackedSequence: number | undefined;
}): PtyViewState {
  const rendererAttached = input.renderers > 0;
  return {
    viewState: input.visible ? "visible" : "hidden",
    rendererAttached,
    ...(!rendererAttached && input.ackedSequence !== undefined
      ? { ackedSequence: input.ackedSequence }
      : {}),
  };
}

/** Sends the state unless it equals the last push for this process; failures are logged. */
export function pushTerminalHostViewState(
  session: TerminalSessionState,
  view: PtyViewState,
  log: (message: string, detail: Record<string, unknown>) => void,
): void {
  const host = session.host;
  const control = session.process?.lifecycle;
  if (!host?.lifecycle || !control || session.status !== "running") return;
  const state = host.ownerBusyHint ? { ...view, ownerBusyHint: host.ownerBusyHint } : view;
  const key = JSON.stringify(state);
  if (host.lastViewPush === key) return;
  host.lastViewPush = key;
  void control.setViewState(state).catch((cause: unknown) => {
    if (session.host === host && host.lastViewPush === key) host.lastViewPush = undefined;
    log("terminal host view state push failed", {
      threadId: session.threadId,
      terminalId: session.terminalId,
      cause: String(cause),
    });
  });
}

/**
 * Records a Direct SSH owner hint (M7) and re-sends the pane's view state when it changed. Only
 * host-managed sessions carry it; the push itself is deduplicated like every view push.
 */
export function setTerminalOwnerBusyHint(
  session: TerminalSessionState,
  hint: NonNullable<TerminalSessionHostState["ownerBusyHint"]>,
  viewChanged: ((threadId: string, terminalId: string) => void) | undefined,
): void {
  const host = session.host;
  if (!host?.lifecycle || host.ownerBusyHint === hint) return;
  host.ownerBusyHint = hint;
  viewChanged?.(session.threadId, session.terminalId);
}

/** Attached session streams per pane, and the sequence the last one acknowledged. */
export class TerminalRendererRegistry {
  private readonly counts = new Map<string, number>();
  private readonly acked = new Map<string, number>();

  attach(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.acked.delete(key);
  }

  detach(key: string, ackedSequence: number | undefined): void {
    const next = (this.counts.get(key) ?? 1) - 1;
    if (next > 0) {
      this.counts.set(key, next);
      return;
    }
    this.counts.delete(key);
    if (ackedSequence !== undefined) this.acked.set(key, ackedSequence);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  ackedSequence(key: string): number | undefined {
    return this.acked.get(key);
  }

  forget(key: string): void {
    this.acked.delete(key);
  }
}
