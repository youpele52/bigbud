import { describe, expect, it, vi, beforeEach } from "vitest";

import { useStore } from "../stores/main";

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

import { HANDOFF_SKILL_PROMPT, waitForHandoffDocument } from "./handoff";
import { setThreadState, THREAD_ID } from "./handoff.test.shared";

describe("waitForHandoffDocument fallback", () => {
  beforeEach(() => {
    vi.useRealTimers();
    useStore.setState({
      threads: [],
      sidebarThreadsById: {},
    } as never);
    mockDispatchCommand.mockReset();
    mockReadNativeApi.mockClear();
  });

  it("falls back to the last assistant message when no XML handoff block is present", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    setThreadState({
      messages: [
        {
          id: "m1",
          role: "user",
          text: HANDOFF_SKILL_PROMPT,
          streaming: false,
          createdAt: "1",
        },
      ],
      latestTurn: { turnId: "turn-1" },
      session: { status: "running", activeTurnId: "turn-1" },
    });

    const promise = waitForHandoffDocument(THREAD_ID, {
      timeoutMs: 10_000,
      requestMessageId: "m1",
    });

    vi.advanceTimersByTimeAsync(150).then(() => {
      setThreadState({
        messages: [
          {
            id: "m1",
            role: "user",
            text: HANDOFF_SKILL_PROMPT,
            streaming: false,
            createdAt: "1",
          },
          {
            id: "m2",
            role: "assistant",
            text: "# Fallback handoff\n\nThis provider ignored the XML tag instruction but still produced a usable markdown handoff document.",
            turnId: "turn-1",
            streaming: false,
            createdAt: "2",
          },
        ],
        latestTurn: { turnId: "turn-1" },
        session: { status: "ready", activeTurnId: null },
      });
    });

    await expect(promise).resolves.toBe(
      "# Fallback handoff\n\nThis provider ignored the XML tag instruction but still produced a usable markdown handoff document.",
    );
  });

  it("prefers the XML handoff block over plain markdown fallback", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    setThreadState({
      messages: [
        {
          id: "m1",
          role: "user",
          text: HANDOFF_SKILL_PROMPT,
          streaming: false,
          createdAt: "1",
        },
      ],
      latestTurn: { turnId: "turn-1" },
      session: { status: "running", activeTurnId: "turn-1" },
    });

    const promise = waitForHandoffDocument(THREAD_ID, {
      timeoutMs: 10_000,
      requestMessageId: "m1",
    });

    vi.advanceTimersByTimeAsync(150).then(() => {
      setThreadState({
        messages: [
          {
            id: "m1",
            role: "user",
            text: HANDOFF_SKILL_PROMPT,
            streaming: false,
            createdAt: "1",
          },
          {
            id: "m2",
            role: "assistant",
            text: "# Plain markdown that should be ignored.",
            turnId: "turn-1",
            streaming: false,
            createdAt: "2",
          },
          {
            id: "m3",
            role: "assistant",
            text: "<handoff_document>\n# XML handoff\n\nBody\n</handoff_document>",
            turnId: "turn-1",
            streaming: false,
            createdAt: "3",
          },
        ],
        latestTurn: { turnId: "turn-1" },
        session: { status: "ready", activeTurnId: null },
      });
    });

    await expect(promise).resolves.toBe("# XML handoff\n\nBody");
  });
});
