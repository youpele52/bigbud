import * as Effect from "effect/Effect";
import type { TerminalActivityShape } from "../Services/TerminalActivity.ts";
import { createTerminalSubmitDetector } from "../activity/terminalSubmitDetector.ts";
import { TerminalWorkSignalReader } from "../activity/terminalWorkSignalReader.ts";
import type { TerminalSessionState } from "./Manager.types.ts";

export type TerminalWorkSink = Pick<TerminalActivityShape, "submit" | "finished">;

interface SessionSignals {
  readonly epoch: number;
  readonly reader: TerminalWorkSignalReader;
  readonly submitted: (data: string) => boolean;
  /** When the process poll last saw a foreground subprocess start, for the fallback duration. */
  pollStartedAt: number | null;
}

/**
 * Per-session terminal work signals for every PTY, local or remote: Enter in client input,
 * OSC 133 / agent markers in output, and the process-poll fallback while no shell integration
 * marker has been seen. State is per runtime epoch, so a restart starts clean.
 */
export function makeTerminalWorkSignals(sink: TerminalWorkSink | undefined, now = Date.now) {
  const states = new WeakMap<TerminalSessionState, SessionSignals>();
  const stateFor = (session: TerminalSessionState) => {
    const existing = states.get(session);
    if (existing && existing.epoch === session.runtimeEpoch) return existing;
    const created: SessionSignals = {
      epoch: session.runtimeEpoch,
      reader: new TerminalWorkSignalReader(now),
      submitted: createTerminalSubmitDetector(),
      pollStartedAt: null,
    };
    states.set(session, created);
    return created;
  };

  return {
    enabled: sink !== undefined,
    /** Client keystrokes only; bigbud's own writes never reach this. */
    input: (session: TerminalSessionState, data: string): Effect.Effect<void> =>
      sink && stateFor(session).submitted(data)
        ? sink.submit(session.threadId, session.terminalId, now())
        : Effect.void,
    /** Observes output (never modifies it); returns work to report, or nothing on the hot path. */
    output: (session: TerminalSessionState, data: string): Effect.Effect<void> | undefined => {
      if (!sink) return undefined;
      const signals = stateFor(session).reader.receive(data);
      return signals.length === 0
        ? undefined
        : Effect.forEach(
            signals,
            (signal) => sink.finished(session.threadId, session.terminalId, signal),
            { discard: true },
          );
    },
    /** The poll's running→idle transition is the fallback for shells without OSC 133. */
    activity: (session: TerminalSessionState, running: boolean): Effect.Effect<void> => {
      if (!sink) return Effect.void;
      const state = stateFor(session);
      const at = now();
      if (running) {
        state.pollStartedAt = at;
        return Effect.void;
      }
      const startedAt = state.pollStartedAt;
      state.pollStartedAt = null;
      if (startedAt === null || state.reader.shellIntegrationSeen) return Effect.void;
      return sink.finished(session.threadId, session.terminalId, {
        atMs: at,
        exitCode: null,
        durationMs: Math.max(0, at - startedAt),
        source: "process-poll",
      });
    },
  };
}

export type TerminalWorkSignals = ReturnType<typeof makeTerminalWorkSignals>;
