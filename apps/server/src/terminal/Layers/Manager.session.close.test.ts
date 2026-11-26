import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { expect } from "vitest";

import { makeTerminalClose } from "./Manager.session.close";
import { createTerminalSessionState } from "./Manager.session.state";
import type { SessionApiContext } from "./Manager.session.types";
import { confirmTerminalProcessStopped } from "./Manager.process.stop";
import type { TerminalSessionState } from "./Manager.types";

function recordingTracer() {
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const attributes = (name: string) =>
    spans
      .filter((span) => span.name === name)
      .map((span) => ({
        threadId: span.attributes.get("terminal.thread_id"),
        terminalId: span.attributes.get("terminal.terminal_id"),
        reason: span.attributes.get("terminal.close_reason"),
      }));
  return { tracer, attributes };
}

function session(terminalId: string): TerminalSessionState {
  return createTerminalSessionState({
    threadId: "thread-1",
    terminalId,
    executionTargetId: "local",
    dropPathMode: "posix",
    cwd: "/project",
    worktreePath: null,
    history: "",
    cols: 80,
    rows: 24,
    runtimeEnv: null,
  });
}

function closeContext(sessions: TerminalSessionState[]) {
  const find = (terminalId: string) =>
    Option.fromNullishOr(sessions.find((value) => value.terminalId === terminalId));
  return {
    withThreadLock: (_threadId: string, effect: Effect.Effect<unknown>) => effect,
    getSession: (_threadId: string, terminalId: string) => Effect.succeed(find(terminalId)),
    sessionsForThread: () => Effect.succeed(sessions),
    historyTerminalIdsForThread: () => Effect.succeed([]),
    historyExists: () => Effect.succeed(false),
    flushPtyOutput: () => Effect.void,
    stopProcess: (value: TerminalSessionState) => confirmTerminalProcessStopped(value, 10),
    persistHistory: () => Effect.void,
    releaseWorktreeLease: () => Effect.void,
    flushPersist: () => Effect.void,
    modifyManagerState: <A>(
      f: (state: { sessions: Map<string, unknown> }) => readonly [A, unknown],
    ) => Effect.sync(() => f({ sessions: new Map() })[0]),
    deleteHistory: () => Effect.void,
    deleteAllHistoryForThread: () => Effect.void,
  } as unknown as SessionApiContext;
}

it.effect("records threadId, terminalId and the default user-close reason on close", () =>
  Effect.gen(function* () {
    const { tracer, attributes } = recordingTracer();
    const close = makeTerminalClose(closeContext([session("default")]));
    yield* close({ threadId: "thread-1", terminalId: "default" }).pipe(Effect.withTracer(tracer));
    const expected = { threadId: "thread-1", terminalId: "default", reason: "user-close" };
    expect(attributes("terminal.closeSession")).toEqual([expected]);
    expect(attributes("terminal.confirmStopped")).toEqual([expected]);
  }),
);

it.effect("records an explicit reason on every pane of a thread close", () =>
  Effect.gen(function* () {
    const { tracer, attributes } = recordingTracer();
    const close = makeTerminalClose(closeContext([session("a"), session("b")]));
    yield* close({ threadId: "thread-1" }, "archive").pipe(Effect.withTracer(tracer));
    expect(attributes("terminal.closeSession")).toEqual([
      { threadId: "thread-1", terminalId: "a", reason: "archive" },
      { threadId: "thread-1", terminalId: "b", reason: "archive" },
    ]);
  }),
);

it.effect("records the stop reason a caller passes, defaulting to user-close", () =>
  Effect.gen(function* () {
    const { tracer, attributes } = recordingTracer();
    yield* confirmTerminalProcessStopped(session("idle"), 10, "idle").pipe(
      Effect.withTracer(tracer),
    );
    yield* confirmTerminalProcessStopped(session("plain"), 10).pipe(Effect.withTracer(tracer));
    expect(attributes("terminal.confirmStopped")).toEqual([
      { threadId: "thread-1", terminalId: "idle", reason: "idle" },
      { threadId: "thread-1", terminalId: "plain", reason: "user-close" },
    ]);
  }),
);
