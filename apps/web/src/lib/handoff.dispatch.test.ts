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

import { dispatchHandoffSkillTurn, HandoffError, HANDOFF_SKILL_PROMPT } from "./handoff";
import { THREAD_ID } from "./handoff.test.shared";

describe("dispatchHandoffSkillTurn", () => {
  beforeEach(() => {
    vi.useRealTimers();
    useStore.setState({
      threads: [],
      sidebarThreadsById: {},
    } as never);
    mockDispatchCommand.mockReset();
    mockReadNativeApi.mockClear();
  });

  it("dispatches a thread.turn.start with the handoff skill mention", async () => {
    const messageId = await dispatchHandoffSkillTurn({
      threadId: THREAD_ID,
      runtimeMode: "full-access",
      interactionMode: "default",
    });

    expect(mockDispatchCommand).toHaveBeenCalledTimes(1);
    const command = mockDispatchCommand.mock.calls[0]?.[0];
    expect(command?.type).toBe("thread.turn.start");
    expect(command?.threadId).toBe(THREAD_ID);
    expect(command?.message.role).toBe("user");
    expect(command?.message.text).toBe(HANDOFF_SKILL_PROMPT);
    expect(command?.message.messageId).toBe(messageId);
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
