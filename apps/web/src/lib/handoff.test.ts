import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ThreadId } from "@bigbud/contracts";

const mockDispatchCommand = vi.hoisted(() => vi.fn());
const mockReadNativeApi = vi.hoisted(() =>
  vi.fn(() => ({
    orchestration: {
      dispatchCommand: mockDispatchCommand,
    },
  })),
);

vi.mock("../rpc/nativeApi", () => ({
  readNativeApi: mockReadNativeApi,
}));

import { dispatchHandoffSkillTurn, HandoffError, waitForHandoffSummary } from "./handoff";
import { useStore } from "../stores/main";

const THREAD_ID = "thread-1" as ThreadId;

function setThreadState(state: {
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    turnId?: string | null;
    streaming: boolean;
    createdAt: string;
  }>;
  latestTurn?: { turnId: string } | null;
  session?: { status: "ready" | "running"; activeTurnId: string | null } | null;
}) {
  useStore.setState({
    threads: [
      {
        id: THREAD_ID,
        messages: state.messages,
        latestTurn: state.latestTurn ?? null,
        session: state.session ?? null,
      },
    ],
    sidebarThreadsById: {
      [THREAD_ID]: {
        id: THREAD_ID,
        session: state.session ?? null,
      },
    },
  } as never);
}

describe("handoff", () => {
  beforeEach(() => {
    vi.useRealTimers();
    useStore.setState({
      threads: [],
      sidebarThreadsById: {},
    } as never);
    mockDispatchCommand.mockReset();
    mockReadNativeApi.mockClear();
  });

  describe("dispatchHandoffSkillTurn", () => {
    it("dispatches a thread.turn.start with /skills handoff", async () => {
      await dispatchHandoffSkillTurn({
        threadId: THREAD_ID,
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      expect(mockDispatchCommand).toHaveBeenCalledTimes(1);
      const command = mockDispatchCommand.mock.calls[0]?.[0];
      expect(command?.type).toBe("thread.turn.start");
      expect(command?.threadId).toBe(THREAD_ID);
      expect(command?.message.role).toBe("user");
      expect(command?.message.text).toBe("/skills handoff");
      expect(command?.runtimeMode).toBe("full-access");
      expect(command?.interactionMode).toBe("default");
    });

    it("throws when native API is unavailable", async () => {
      mockReadNativeApi.mockReturnValueOnce(null as never);

      await expect(
        dispatchHandoffSkillTurn({
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
      ).rejects.toBeInstanceOf(HandoffError);
    });
  });

  describe("waitForHandoffSummary", () => {
    it("resolves with the assistant message for the handoff turn", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      setThreadState({
        messages: [
          { id: "m1", role: "user", text: "/skills handoff", streaming: false, createdAt: "1" },
        ],
        latestTurn: { turnId: "turn-1" },
        session: { status: "running", activeTurnId: "turn-1" },
      });

      const promise = waitForHandoffSummary(THREAD_ID, { timeoutMs: 5000 });

      vi.advanceTimersByTimeAsync(150).then(() => {
        setThreadState({
          messages: [
            { id: "m1", role: "user", text: "/skills handoff", streaming: false, createdAt: "1" },
            {
              id: "m2",
              role: "assistant",
              text: "Handoff summary text",
              turnId: "turn-1",
              streaming: false,
              createdAt: "2",
            },
          ],
          latestTurn: { turnId: "turn-1" },
          session: { status: "ready", activeTurnId: null },
        });
      });

      await expect(promise).resolves.toBe("Handoff summary text");
    });

    it("rejects when the source thread disappears", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      setThreadState({
        messages: [
          { id: "m1", role: "user", text: "/skills handoff", streaming: false, createdAt: "1" },
        ],
        latestTurn: { turnId: "turn-1" },
        session: { status: "running", activeTurnId: "turn-1" },
      });

      const promise = waitForHandoffSummary(THREAD_ID, { timeoutMs: 5000 });

      vi.advanceTimersByTimeAsync(150).then(() => {
        useStore.setState({ threads: [], sidebarThreadsById: {} } as never);
      });

      await expect(promise).rejects.toBeInstanceOf(HandoffError);
    });

    it("rejects on timeout", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      setThreadState({
        messages: [],
        latestTurn: null,
        session: { status: "ready", activeTurnId: null },
      });

      const promise = waitForHandoffSummary(THREAD_ID, { timeoutMs: 50 });

      vi.advanceTimersByTimeAsync(100);

      await expect(promise).rejects.toBeInstanceOf(HandoffError);
    });
  });
});
