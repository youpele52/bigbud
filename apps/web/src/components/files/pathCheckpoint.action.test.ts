import { CommandId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { dispatchPathCheckpointAction } from "./pathCheckpoint.action";

describe("path checkpoint context-menu action", () => {
  it("dispatches capture without confirmation", async () => {
    const dispatchCommand = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn();
    await dispatchPathCheckpointAction({
      operation: "capture",
      threadId: ThreadId.makeUnsafe("thread-1"),
      path: "src/file.ts",
      commandId: CommandId.makeUnsafe("command-1"),
      api: { dialogs: { confirm }, orchestration: { dispatchCommand } },
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.path-checkpoint.capture", path: "src/file.ts" }),
    );
  });

  it("requires destructive restore confirmation", async () => {
    const dispatchCommand = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn().mockResolvedValue(false);
    await dispatchPathCheckpointAction({
      operation: "restore",
      threadId: ThreadId.makeUnsafe("thread-1"),
      path: "src/file.ts",
      commandId: CommandId.makeUnsafe("command-1"),
      api: { dialogs: { confirm }, orchestration: { dispatchCommand } },
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("cannot be undone"));
    expect(dispatchCommand).not.toHaveBeenCalled();
  });
});
