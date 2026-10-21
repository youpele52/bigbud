import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@bigbud/contracts";
import type { CopilotClient, CopilotSession, SessionEvent } from "@github/copilot-sdk";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import {
  getThreadOrchestrationToolDispatcher,
  setThreadOrchestrationToolDispatcher,
} from "../../../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../../Services/Copilot/Adapter.ts";
import { makeCopilotAdapterLive } from "./Adapter.ts";

const THREAD_ID = ThreadId.makeUnsafe("copilot-steer");

function makeFakeSession(sessionId: string) {
  let handler: ((event: SessionEvent) => void) | undefined;
  const send = vi.fn<CopilotSession["send"]>().mockResolvedValue("message");
  return {
    send,
    emit: (event: Partial<SessionEvent> & { readonly type: string }) =>
      handler?.({ data: {}, timestamp: new Date().toISOString(), ...event } as SessionEvent),
    session: {
      sessionId,
      on: (next: (event: SessionEvent) => void) => {
        handler = next;
        return () => {};
      },
      send,
      setModel: async () => {},
      abort: async () => {},
      disconnect: async () => {},
    },
  };
}

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "copilot-steer-"));
  const sessions = [makeFakeSession("copilot-session-1"), makeFakeSession("copilot-session-2")];
  let created = 0;
  const layer = makeCopilotAdapterLive({
    clientFactory: () =>
      ({
        createSession: async () => sessions[created++]!.session,
        stop: async () => {},
      }) as unknown as CopilotClient,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "copilot-steer-" })),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
  const start = Effect.gen(function* () {
    const previous = getThreadOrchestrationToolDispatcher();
    const unused = () => Effect.die(new Error("Orchestration tools must not run in this test"));
    setThreadOrchestrationToolDispatcher({
      rename: unused,
      archive: unused,
      getStatus: unused,
      listPinned: unused,
      setPinned: unused,
      computerUse: unused,
      browser: unused,
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setThreadOrchestrationToolDispatcher(previous);
        rmSync(root, { recursive: true, force: true });
      }),
    );
    const adapter = yield* CopilotAdapter;
    yield* adapter.startSession({
      threadId: THREAD_ID,
      provider: "copilot",
      runtimeMode: "approval-required",
    });
    return adapter;
  });
  return { layer, sessions, start };
}

const activeTurnId = (adapter: CopilotAdapterShape) =>
  adapter.listSessions().pipe(Effect.map((sessions) => sessions[0]?.activeTurnId));

describe("CopilotAdapter turn control", () => {
  it.effect("declares native steering", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      expect(adapter.capabilities.supportsSteer).toBe(true);
      expect(adapter.capabilities.turnControl?.nativeSteer).toBe(true);
      expect(adapter.steerTurn).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("enqueues turns, refuses a second turn, and steers the running one", () => {
    const { layer, sessions, start } = setup();
    return Effect.gen(function* () {
      const adapter = yield* start;
      const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "First" });
      expect(sessions[0]!.send).toHaveBeenLastCalledWith({ prompt: "First", mode: "enqueue" });

      const busy = yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "Second" })
        .pipe(Effect.flip);
      expect(String(busy)).toContain(`Turn '${turn.turnId}' is already active.`);
      expect(sessions[0]!.send).toHaveBeenCalledOnce();

      // Copilot renames the turn per assistant step; steering checks only that one is active.
      sessions[0]!.emit({ type: "assistant.turn_start", data: { turnId: "step-2" } as never });
      yield* Effect.yieldNow;
      yield* adapter.steerTurn!(THREAD_ID, "Also check the tests", turn.turnId);
      expect(sessions[0]!.send).toHaveBeenLastCalledWith({
        prompt: "Also check the tests",
        mode: "immediate",
      });

      sessions[0]!.emit({ type: "session.idle" });
      yield* Effect.yieldNow;
      expect(yield* activeTurnId(adapter)).toBeUndefined();
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Third" });
      expect(sessions[0]!.send).toHaveBeenLastCalledWith({ prompt: "Third", mode: "enqueue" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to steer when no turn is active", () => {
    const { layer, sessions, start } = setup();
    return Effect.gen(function* () {
      const adapter = yield* start;
      const failure = yield* adapter.steerTurn!(THREAD_ID, "Too late").pipe(Effect.flip);
      expect(String(failure)).toContain("no active GitHub Copilot turn to steer");
      expect(sessions[0]!.send).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });

  it.effect("clears the active turn when the send fails so the session stays usable", () => {
    const { layer, sessions, start } = setup();
    return Effect.gen(function* () {
      const adapter = yield* start;
      sessions[0]!.send.mockRejectedValueOnce(new Error("network down"));
      const failure = yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "First" })
        .pipe(Effect.flip);
      expect(String(failure)).toContain("network down");
      expect(yield* activeTurnId(adapter)).toBeUndefined();
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Retry" });
      expect(sessions[0]!.send).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("renews a lost session once while steering", () => {
    const { layer, sessions, start } = setup();
    return Effect.gen(function* () {
      const adapter = yield* start;
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "First" });
      sessions[0]!.send.mockRejectedValueOnce(new Error("Session not found"));
      yield* adapter.steerTurn!(THREAD_ID, "Keep going");
      expect(sessions[1]!.send).toHaveBeenCalledExactlyOnceWith({
        prompt: "Keep going",
        mode: "immediate",
      });
    }).pipe(Effect.provide(layer));
  });
});
