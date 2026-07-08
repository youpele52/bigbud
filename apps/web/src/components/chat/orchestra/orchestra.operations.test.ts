import { ProjectId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDispatchCommand = vi.hoisted(() => vi.fn());
const mockReadNativeApi = vi.hoisted(() =>
  vi.fn(() => ({
    orchestration: {
      dispatchCommand: mockDispatchCommand,
    },
  })),
);
const mockWaitForStartedServerThread = vi.hoisted(() => vi.fn());

vi.mock("~/rpc/nativeApi", () => ({
  readNativeApi: mockReadNativeApi,
}));

vi.mock("../view/ChatView.threadWait.logic", () => ({
  waitForStartedServerThread: mockWaitForStartedServerThread,
}));

import { createOrchestraOperations, type OrchestraAssignmentDraft } from "./orchestra.runner";

const assignments: OrchestraAssignmentDraft[] = [
  {
    id: "a",
    modelSelection: { provider: "codex", model: "gpt-5" },
    prompt: "First task",
  },
];

describe("createOrchestraOperations", () => {
  beforeEach(() => {
    mockDispatchCommand.mockReset();
    mockDispatchCommand.mockResolvedValue({ sequence: 1 });
    mockReadNativeApi.mockClear();
    mockWaitForStartedServerThread.mockReset();
  });

  it("does not fail a child thread after dispatch just because projection is not visible yet", async () => {
    const operations = createOrchestraOperations({
      activeProject: {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
      },
      activeThread: null,
      interactionMode: "default",
      runtimeMode: "full-access",
    });
    const parentThread = await operations.createParentThread({
      assignments,
      scoreName: "Testing",
    });
    const childThreadId = await operations.createThread({
      assignment: assignments[0]!,
      index: 0,
      parentThread,
    });

    expect(childThreadId).toBeTruthy();
    expect(mockDispatchCommand).toHaveBeenCalledTimes(3);
    expect(mockDispatchCommand.mock.calls.map((call) => call[0].type)).toEqual([
      "thread.create",
      "thread.create",
      "thread.turn.start",
    ]);
    expect(mockWaitForStartedServerThread).not.toHaveBeenCalled();
  });
});
