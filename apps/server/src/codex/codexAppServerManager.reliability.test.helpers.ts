import { ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { vi } from "vitest";
import type { ProviderPreparedRewind } from "../provider/Services/ProviderRewind.ts";
import type { CodexSessionContext } from "./codexAppServerManager.types.ts";
import type { TurnOps } from "./codexAppServerManager.turn.ts";

export const exactRewindInput: ProviderPreparedRewind = {
  nativeThreadId: "native",
  runtimeVersion: "0.166.0",
  threadId: ThreadId.makeUnsafe("canonical"),
  operationId: "operation",
  sessionEpoch: 2,
  expectedTurnIds: [TurnId.makeUnsafe("t1"), TurnId.makeUnsafe("t2")],
  retainedTurnId: TurnId.makeUnsafe("t1"),
  firstRemovedTurnId: TurnId.makeUnsafe("t2"),
  currentTurnCount: 2,
  targetTurnCount: 1,
  checkpointRef: "refs/checkpoint/1",
};

export function codexReliabilityHarness() {
  const context = {
    session: {
      threadId: exactRewindInput.threadId,
      sessionEpoch: 2,
      status: "ready",
      resumeCursor: { threadId: "native" },
    },
    child: { exitCode: null, killed: false },
    runtimeVersion: "0.166.0",
    stopping: false,
    ownedTurnId: TurnId.makeUnsafe("t2"),
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabChildTurns: new Map(),
  } as unknown as CodexSessionContext;
  const state = {
    thread: {
      id: "native",
      historyMode: "paginated",
      ephemeral: false,
      status: { type: "idle" },
      updatedAt: 1,
    },
    turns: ["t1", "t2"].map((id) => ({
      id,
      items: [] as unknown[],
      itemsView: "full",
      status: "completed",
      completedAt: 1_700_000_000,
    })),
  };
  const sendRequest = vi.fn(
    async (_context: CodexSessionContext, method: string, params: unknown): Promise<unknown> => {
      if (method === "thread/read") return { thread: structuredClone(state.thread) };
      if (method === "thread/turns/list")
        return { data: structuredClone(state.turns), nextCursor: null };
      if (method === "thread/revert") {
        const boundary = (params as { beforeTurnId: string }).beforeTurnId;
        state.turns = state.turns.slice(
          0,
          state.turns.findIndex((turn) => turn.id === boundary),
        );
        state.thread.updatedAt++;
        return { thread: { ...state.thread, turns: [] } };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  );
  const ops = {
    sendRequest,
    updateSession: vi.fn(),
    emitEvent: vi.fn(),
    writeMessage: vi.fn(),
  } as unknown as TurnOps;
  return { context, state, sendRequest, ops };
}
