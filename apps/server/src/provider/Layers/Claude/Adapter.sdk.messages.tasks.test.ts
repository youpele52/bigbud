import { describe, expect, it } from "vitest";

import { decodeClaudeTaskUpdatedMessage } from "./Adapter.sdk.messages.ts";

describe("Claude task update decoding", () => {
  it.each(["in_progress", "complete", "done"])("accepts %s status aliases", (status) => {
    expect(
      decodeClaudeTaskUpdatedMessage({
        type: "system",
        subtype: "task_updated",
        uuid: `task-update-${status}`,
        session_id: "session-1",
        task_id: "task-1",
        patch: { status },
      }),
    ).toMatchObject({ taskId: "task-1", patch: { status } });
  });

  it("rejects unknown task statuses", () => {
    expect(
      decodeClaudeTaskUpdatedMessage({
        type: "system",
        subtype: "task_updated",
        uuid: "task-update-invalid",
        session_id: "session-1",
        task_id: "task-1",
        patch: { status: "finished" },
      }),
    ).toBeUndefined();
  });
});
