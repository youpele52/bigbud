import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ThreadId, TurnId } from "@bigbud/contracts";
import type { CopilotClient, SessionEvent } from "@github/copilot-sdk";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  getThreadOrchestrationToolDispatcher,
  setThreadOrchestrationToolDispatcher,
} from "../../../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CopilotAdapter } from "../../Services/Copilot/Adapter.ts";
import { makeCopilotAdapterLive } from "./Adapter.ts";
import { mapCopilotSubagentEvent } from "./Adapter.mapEvent.subagents.ts";
import type { ActiveCopilotSession } from "./Adapter.types.ts";

const threadId = ThreadId.makeUnsafe("copilot-child-lifecycle");
const nativeEvent = (type: string, data: object, agentId?: string) =>
  ({
    type,
    data,
    agentId,
    timestamp: new Date().toISOString(),
    id: crypto.randomUUID(),
  }) as SessionEvent;

describe("Copilot child lifecycle isolation", () => {
  it.effect("does not replace or clear the root turn for child frames", () => {
    let handler: ((event: SessionEvent) => void) | undefined;
    const layer = makeCopilotAdapterLive({
      clientFactory: () =>
        ({
          createSession: async () => ({
            sessionId: "native-session",
            on: (next: typeof handler) => {
              handler = next;
              return () => {};
            },
            send: async () => "message",
            disconnect: async () => {},
          }),
          stop: async () => {},
        }) as unknown as CopilotClient,
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/copilot-child-lifecycle", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const previous = getThreadOrchestrationToolDispatcher();
      const unused = () => Effect.die("Unexpected tool invocation");
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
        Effect.sync(() => setThreadOrchestrationToolDispatcher(previous)),
      );
      const adapter = yield* CopilotAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "copilot",
        runtimeMode: "approval-required",
      });
      const root = yield* adapter.sendTurn({ threadId, input: "Review" });
      for (const event of [
        nativeEvent("assistant.turn_start", { turnId: "child-turn" }, "child"),
        nativeEvent("session.idle", {}, "child"),
        nativeEvent("abort", { reason: "child cancelled" }, "child"),
      ]) {
        handler?.(event);
        yield* Effect.yieldNow;
        expect((yield* adapter.listSessions())[0]?.activeTurnId).toBe(root.turnId);
      }
      handler?.(nativeEvent("session.idle", {}));
      yield* Effect.yieldNow;
      expect((yield* adapter.listSessions())[0]?.activeTurnId).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.each(["child", undefined])(
    "retains the launching turn at completion (agentId=%s)",
    (agentId) => {
      const session = {
        threadId,
        sessionEpoch: 1,
        activeTurnId: TurnId.makeUnsafe("root-1"),
      } as ActiveCopilotSession;
      const data = {
        toolCallId: "call",
        agentName: "review",
        agentDisplayName: "Review",
        agentDescription: "Review",
      };
      mapCopilotSubagentEvent(
        session,
        nativeEvent("subagent.started", data, "child"),
        EventId.makeUnsafe("start"),
      );
      session.activeTurnId = TurnId.makeUnsafe("root-2");
      const done = mapCopilotSubagentEvent(
        session,
        nativeEvent("subagent.completed", data, agentId),
        EventId.makeUnsafe("done"),
      );
      expect(done).toMatchObject([
        {
          type: "task.updated",
          turnId: "root-1",
          payload: { turnId: "root-1", status: "completed" },
        },
      ]);
    },
  );
});
