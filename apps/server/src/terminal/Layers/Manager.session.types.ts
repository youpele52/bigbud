import { type TerminalEvent, type TerminalSessionSnapshot } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import {
  type TerminalCwdError,
  type TerminalManagerShape,
  type TerminalSessionLookupError,
} from "../Services/Manager";
import {
  type TerminalManagerState,
  type TerminalSessionState,
  type TerminalStartInput,
} from "./Manager.types";

export interface SessionApiContext {
  publishEvent: (event: TerminalEvent) => Effect.Effect<void>;
  modifyManagerState: <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => Effect.Effect<A>;
  getSession: (
    threadId: string,
    terminalId: string,
  ) => Effect.Effect<Option.Option<TerminalSessionState>>;
  requireSession: (
    threadId: string,
    terminalId: string,
  ) => Effect.Effect<TerminalSessionState, TerminalSessionLookupError>;
  sessionsForThread: (threadId: string) => Effect.Effect<TerminalSessionState[]>;
  withThreadLock: <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  stopProcess: (session: TerminalSessionState) => Effect.Effect<void>;
  startSession: (
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
  ) => Effect.Effect<void>;
  flushPtyOutput: (threadId: string, terminalId: string) => Effect.Effect<void>;
  persistHistory: (threadId: string, terminalId: string, history: string) => Effect.Effect<void>;
  flushPersist: (threadId: string, terminalId: string) => Effect.Effect<void>;
  readHistory: (threadId: string, terminalId: string) => Effect.Effect<string>;
  deleteHistory: (threadId: string, terminalId: string) => Effect.Effect<void>;
  deleteAllHistoryForThread: (threadId: string) => Effect.Effect<void>;
  evictInactiveSessionsIfNeeded: () => Effect.Effect<void>;
  assertValidCwd: (cwd: string) => Effect.Effect<void, TerminalCwdError>;
  snapshot: (session: TerminalSessionState) => TerminalSessionSnapshot;
  terminalEventListeners: Set<(event: TerminalEvent) => Effect.Effect<void>>;
}

export type { TerminalManagerShape };
