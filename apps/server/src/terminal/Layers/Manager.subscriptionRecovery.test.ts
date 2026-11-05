import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { subscribeToTerminalEvents } from "./Manager.session.subscription";
import { createTerminalSessionState } from "./Manager.session.state";
import type { TerminalManagerState } from "./Manager.types";
import { expect } from "vitest";
import type { TerminalEvent } from "@bigbud/contracts";
import { createManager, openInput } from "./Manager.test.helpers";

for (const status of ["running", "exited", "error"] as const) {
  it.effect(`reconciles ${status} WSL lifecycle without overriding live client detection`, () =>
    Effect.gen(function* () {
      const session = createTerminalSessionState({
        threadId: "thread",
        terminalId: "wsl",
        executionTargetId: "wsl:Ubuntu",
        dropPathMode: "posix",
        cwd: "/project",
        worktreePath: null,
        history: "",
        cols: 80,
        rows: 24,
        runtimeEnv: null,
      });
      session.status = status;
      const state: TerminalManagerState = {
        sessions: new Map([["wsl", session]]),
        killFibers: new Map(),
      };
      const events: TerminalEvent[] = [];
      const stop = yield* subscribeToTerminalEvents(
        {
          modifyManagerState: (f) => Effect.sync(() => f(state)[0]),
          getSession: () => Effect.succeed(Option.some(session)),
          terminalEventListeners: new Set(),
        },
        (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        { outputScope: "legacyDetection" },
      );
      expect(events.some((event) => event.type === "agentIdentity")).toBe(false);
      if (status === "running") expect(events).toEqual([]);
      else {
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "activity", hasRunningSubprocess: false }),
            expect.objectContaining({ type: status === "exited" ? "exited" : "error" }),
          ]),
        );
      }
      stop();
    }),
  );
}

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "global terminal subscription recovery",
  (it) => {
    it.effect("replays current stopped state and activity after a subscriber missed exit", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        ptyAdapter.processes[0]!.emitExit({ exitCode: 7, signal: null });
        yield* Effect.yieldNow;
        const events: TerminalEvent[] = [];
        const stop = yield* manager.subscribe(
          (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          {
            outputScope: "legacyDetection",
          },
        );
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "activity", hasRunningSubprocess: false }),
            expect.objectContaining({ type: "exited", exitCode: 7 }),
          ]),
        );
        stop();
      }),
    );
    it.effect("replays failed state without claiming an unconfirmed process exit", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        ptyAdapter.spawnFailures.push(new Error("spawn failed"));
        yield* manager.open(openInput());
        const events: TerminalEvent[] = [];
        const stop = yield* manager.subscribe(
          (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          {
            outputScope: "legacyDetection",
          },
        );
        expect(events.some((event) => event.type === "error")).toBe(true);
        expect(
          events.some((event) => event.type === "exited" || event.type === "agentIdentity"),
        ).toBe(false);
        stop();
      }),
    );
  },
);
