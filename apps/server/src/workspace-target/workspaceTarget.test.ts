import { describe, expect, it } from "vitest";

import { resolveWorkspaceExecutionTargetId, resolveWorkspaceTarget } from "./workspaceTarget.ts";

describe("workspaceTarget", () => {
  it("defaults to a local workspace target", () => {
    expect(resolveWorkspaceTarget({ executionTargetId: undefined, cwd: undefined })).toEqual({
      location: "local",
      executionTargetId: "local",
      cwd: undefined,
    });
  });

  it("normalizes remote workspace cwd values", () => {
    expect(
      resolveWorkspaceTarget({
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "  /root/project  ",
      }),
    ).toEqual({
      location: "remote",
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      cwd: "/root/project",
    });
  });

  it("prefers the explicit workspace target over the legacy alias", () => {
    expect(
      resolveWorkspaceExecutionTargetId({
        executionTargetId: "local",
        workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      }),
    ).toBe("ssh:host=devbox&user=root&port=22&auth=ssh-key");
  });
});
