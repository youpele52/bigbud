import { describe, expect, it } from "vitest";

import { resolveTerminalExecutionTargetId } from "./useThreadTerminalDrawer";

describe("resolveTerminalExecutionTargetId", () => {
  it("prefers the migrated thread target over the project target", () => {
    expect(
      resolveTerminalExecutionTargetId({
        serverThread: { workspaceExecutionTargetId: "ssh:new-host" },
        project: { workspaceExecutionTargetId: "ssh:old-host" },
      }),
    ).toBe("ssh:new-host");
  });

  it("uses the project target for draft threads", () => {
    expect(
      resolveTerminalExecutionTargetId({
        serverThread: null,
        project: { workspaceExecutionTargetId: "ssh:new-host" },
      }),
    ).toBe("ssh:new-host");
  });
});
