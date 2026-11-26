/**
 * Session API members for host-backed terminals (plan S3): the screen-spliced session stream,
 * Keep open, lifecycle notices and "Close them". Each member degrades to today's behavior when
 * the session has no host process.
 *
 * @module Manager.session.host
 */
import type { TerminalEvent } from "@bigbud/contracts";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { TERMINAL_RECOVERY_ANSI_MAX_CHARS } from "@bigbud/contracts/workspace/terminal.recovery.ts";
import * as Effect from "effect/Effect";

import { isRemoteAgentLifecycleUnsupported } from "../../remote-agent/remoteAgentPtyClient.types.ts";
import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import type { TerminalManagerShape, TerminalSessionStreamHandle } from "../Services/Manager.ts";
import type { TerminalHostHubRuntime } from "./Manager.hostHub.ts";
import {
  TerminalScreenSplice,
  terminalScreenItem,
  type TerminalScreenSource,
} from "./Manager.hostScreen.ts";
import { toSessionKey } from "./Manager.shell";
import type { TerminalSessionState } from "./Manager.types.ts";

/** A screen transfer is abandoned after this; the view then hydrates from history. */
const SCREEN_FETCH_TIMEOUT_MS = 10_000;

export interface TerminalSessionHostDeps {
  readonly hub: TerminalHostHubRuntime;
  readonly runtime: () => OwnedPtyRuntime | undefined;
  readonly readSession: (threadId: string, terminalId: string) => TerminalSessionState | undefined;
  readonly getSession: (
    threadId: string,
    terminalId: string,
  ) => Effect.Effect<TerminalSessionState | undefined>;
  readonly subscribe: (
    listener: (event: TerminalEvent) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
}

async function fetchLiveScreen(session: TerminalSessionState) {
  const process = session.process;
  const host = session.host;
  if (!process?.screen || !host) return undefined;
  const snapshot = await process.screen.snapshot({
    attachRenderer: true,
    maxAnsiUnits: TERMINAL_RECOVERY_ANSI_MAX_CHARS,
    signal: AbortSignal.timeout(SCREEN_FETCH_TIMEOUT_MS),
  });
  if (session.process !== process || session.host !== host) return undefined;
  return terminalScreenItem({ ...session, runtimeGeneration: host.generation, snapshot });
}

/** A lost PTY's last screen, rebuilt by a host that still has its spool (§8.3, §14). */
async function fetchColdScreen(
  session: TerminalSessionState,
  runtime: OwnedPtyRuntime | undefined,
) {
  const host = session.host;
  if (!host?.ptyId || !runtime?.hostGenerations) return undefined;
  const snapshot = await runtime.hostGenerations.coldSnapshot(host.ptyId, {
    attachRenderer: false,
    maxAnsiUnits: TERMINAL_RECOVERY_ANSI_MAX_CHARS,
    signal: AbortSignal.timeout(SCREEN_FETCH_TIMEOUT_MS),
  });
  return terminalScreenItem({ ...session, runtimeGeneration: host.generation, snapshot });
}

function screenSource(
  session: TerminalSessionState | undefined,
  runtime: () => OwnedPtyRuntime | undefined,
): TerminalScreenSource {
  if (!session || session.status === "starting") return { kind: "pending" };
  const host = session.host;
  if (host?.screen && session.process && session.status === "running")
    return { kind: "host", ledger: host.ledger, fetch: () => fetchLiveScreen(session) };
  if (host && session.endedReason === "host-lost")
    return { kind: "host", ledger: host.ledger, fetch: () => fetchColdScreen(session, runtime()) };
  return session.process ? { kind: "none" } : { kind: "pending" };
}

export function makeTerminalSessionHostApi(
  deps: TerminalSessionHostDeps,
): Required<
  Pick<
    TerminalManagerShape,
    | "subscribeSession"
    | "keepOpen"
    | "subscribeLifecycle"
    | "publishLifecycleNotice"
    | "closeDrainingHosts"
  >
> {
  const { hub } = deps;
  return {
    subscribeSession: (input, sink) =>
      Effect.gen(function* () {
        const { threadId, terminalId } = input;
        const key = toSessionKey(threadId, terminalId);
        // A pane reopened after a restart starts after its view subscribed: wait for its start
        // (local host or a 1.9 remote agent). An in-process start settles this at its first
        // event, with nothing delayed or reordered.
        const waitForStart = true;
        const splice = new TerminalScreenSplice(
          () => screenSource(deps.readSession(threadId, terminalId), deps.runtime),
          sink,
          { acceptScreen: input.acceptScreen, waitForStart },
        );
        const unsubscribe = yield* deps.subscribe((event) =>
          Effect.sync(() => {
            if (event.threadId === threadId && event.terminalId === terminalId) splice.push(event);
          }),
        );
        hub.renderers.attach(key);
        hub.viewChanged(threadId, terminalId);
        let closed = false;
        return {
          start: () => splice.start(),
          unsubscribe: (acknowledgedChars) => {
            if (closed) return;
            closed = true;
            unsubscribe();
            const acked = splice.ackedSequence(acknowledgedChars);
            splice.close();
            hub.renderers.detach(key, acked);
            hub.viewChanged(threadId, terminalId);
          },
        } satisfies TerminalSessionStreamHandle;
      }),
    keepOpen: (input) =>
      Effect.gen(function* () {
        const session = yield* deps.getSession(input.threadId, input.terminalId);
        const control = session?.process?.lifecycle;
        // Not idle-managed (no host, an old agent): nothing to restart.
        if (!session?.host?.lifecycle || !control) return;
        yield* Effect.tryPromise({
          try: async (signal) => {
            try {
              await control.keepOpen(signal);
            } catch (cause) {
              // A host that cannot serve the request has no idle timer to restart.
              if (!isRemoteAgentLifecycleUnsupported(cause)) throw cause;
            }
          },
          catch: (cause) =>
            new TerminalExecutionTargetError({
              threadId: input.threadId,
              terminalId: input.terminalId,
              executionTargetId: session.executionTargetId,
              detail: `The terminal host didn't restart the idle timer: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        });
      }),
    subscribeLifecycle: (listener) => hub.subscribeLifecycle(listener),
    publishLifecycleNotice: (notice) => hub.publishNotice(notice),
    closeDrainingHosts: () =>
      Effect.tryPromise({
        try: () => hub.closeDrainingHosts(),
        catch: (cause) =>
          new TerminalExecutionTargetError({
            threadId: "unknown",
            terminalId: "unknown",
            executionTargetId: "local",
            detail: "Couldn't close the old terminal hosts. They were left running.",
            cause,
          }),
      }),
  };
}
