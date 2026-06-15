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

import { HandoffError, HANDOFF_SKILL_PROMPT, waitForHandoffDocument } from "./handoff";
import { setThreadState, THREAD_ID } from "./handoff.test.shared";

describe("waitForHandoffDocument", () => {
  beforeEach(() => {
    vi.useRealTimers();
    useStore.setState({
      threads: [],
      sidebarThreadsById: {},
    } as never);
    mockDispatchCommand.mockReset();
    mockReadNativeApi.mockClear();
  });

  it("resolves with the handoff document for the handoff turn", async () => {
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
      latestTurn: null,
      session: { status: "ready", activeTurnId: null },
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
            text: "<handoff_document>\n# Handoff\n\nBody\n</handoff_document>",
            turnId: "turn-1",
            streaming: false,
            createdAt: "2",
          },
        ],
        latestTurn: { turnId: "turn-1" },
        session: { status: "ready", activeTurnId: null },
      });
    });

    await expect(promise).resolves.toBe("# Handoff\n\nBody");
  });

  it("ignores earlier handoff attempts and resolves from the requested message id", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    setThreadState({
      messages: [
        {
          id: "m-old-user",
          role: "user",
          text: HANDOFF_SKILL_PROMPT,
          streaming: false,
          createdAt: "1",
        },
        {
          id: "m-old-assistant",
          role: "assistant",
          text: "<handoff_document>\n# Old handoff\n\nOld body\n</handoff_document>",
          turnId: "turn-old",
          streaming: false,
          createdAt: "2",
        },
        {
          id: "m-new-user",
          role: "user",
          text: HANDOFF_SKILL_PROMPT,
          streaming: false,
          createdAt: "3",
        },
      ],
      latestTurn: { turnId: "turn-new" },
      session: { status: "running", activeTurnId: "turn-new" },
    });

    const promise = waitForHandoffDocument(THREAD_ID, {
      timeoutMs: 5000,
      requestMessageId: "m-new-user",
    });

    vi.advanceTimersByTimeAsync(150).then(() => {
      setThreadState({
        messages: [
          {
            id: "m-old-user",
            role: "user",
            text: HANDOFF_SKILL_PROMPT,
            streaming: false,
            createdAt: "1",
          },
          {
            id: "m-old-assistant",
            role: "assistant",
            text: "<handoff_document>\n# Old handoff\n\nOld body\n</handoff_document>",
            turnId: "turn-old",
            streaming: false,
            createdAt: "2",
          },
          {
            id: "m-new-user",
            role: "user",
            text: HANDOFF_SKILL_PROMPT,
            streaming: false,
            createdAt: "3",
          },
          {
            id: "m-new-assistant",
            role: "assistant",
            text: "The user asked for handoff.\n<handoff_document>\n# Fresh handoff\n\nFresh body\n</handoff_document>",
            turnId: "turn-new",
            streaming: false,
            createdAt: "4",
          },
        ],
        latestTurn: { turnId: "turn-new" },
        session: { status: "ready", activeTurnId: null },
      });
    });

    await expect(promise).resolves.toBe("# Fresh handoff\n\nFresh body");
  });

  it("rejects when handoff completes without emitting a document", async () => {
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
    const rejection = expect(promise).rejects.toThrow(
      /Handoff completed without producing a handoff document/,
    );

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
            text: "Let me first read the handoff skill file to understand the format.",
            turnId: "turn-1",
            streaming: false,
            createdAt: "2",
          },
        ],
        latestTurn: { turnId: "turn-1" },
        session: { status: "ready", activeTurnId: null },
      });
    });

    await vi.advanceTimersByTimeAsync(5_500);
    await rejection;
  });

  it("allows the handoff document to arrive shortly after the thread stops running", async () => {
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
            text: "Writing handoff now.",
            turnId: "turn-1",
            streaming: false,
            createdAt: "2",
          },
        ],
        latestTurn: { turnId: "turn-1" },
        session: { status: "ready", activeTurnId: null },
      });
    });

    vi.advanceTimersByTimeAsync(1_000).then(() => {
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
            text: "Writing handoff now.",
            turnId: "turn-1",
            streaming: false,
            createdAt: "2",
          },
          {
            id: "m3",
            role: "assistant",
            text: "<handoff_document>\n# Delayed handoff\n\nDelayed body\n</handoff_document>",
            turnId: "turn-1",
            streaming: false,
            createdAt: "3",
          },
        ],
        latestTurn: { turnId: "turn-1" },
        session: { status: "ready", activeTurnId: null },
      });
    });

    await expect(promise).resolves.toBe("# Delayed handoff\n\nDelayed body");
  });

  it("rejects when the source thread disappears", async () => {
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

    const promise = waitForHandoffDocument(THREAD_ID, { timeoutMs: 5000 });

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

    const promise = waitForHandoffDocument(THREAD_ID, { timeoutMs: 50 });

    vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toBeInstanceOf(HandoffError);
  });
});
