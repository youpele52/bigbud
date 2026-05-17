import { describe, expect, it } from "vitest";

import {
  buildExplicitExecutionTargets,
  resolveProviderRuntimeExecutionTargetId,
  resolveWorkspaceExecutionTargetId,
} from "./providerExecutionTargets";

describe("buildExplicitExecutionTargets", () => {
  it("defaults local workspaces to local runtime", () => {
    expect(buildExplicitExecutionTargets({ workspaceExecutionTargetId: "local" })).toEqual({
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
      executionTargetId: "local",
    });
  });

  it("supports local runtime against a remote workspace", () => {
    expect(
      buildExplicitExecutionTargets({
        workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        providerRuntimeLocation: "local",
      }),
    ).toEqual({
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
    });
  });

  it("supports remote runtime against a remote workspace", () => {
    expect(
      buildExplicitExecutionTargets({
        workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        providerRuntimeLocation: "remote",
      }),
    ).toEqual({
      providerRuntimeExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
    });
  });
});

describe("resolveWorkspaceExecutionTargetId", () => {
  it("prefers the explicit workspace target over the legacy alias", () => {
    expect(
      resolveWorkspaceExecutionTargetId({
        executionTargetId: "ssh:host=provider&user=root&port=22&auth=ssh-key",
        workspaceExecutionTargetId: "ssh:host=workspace&user=root&port=22&auth=ssh-key",
      }),
    ).toBe("ssh:host=workspace&user=root&port=22&auth=ssh-key");
  });
});

describe("resolveProviderRuntimeExecutionTargetId", () => {
  it("prefers the explicit provider runtime target over the workspace target", () => {
    expect(
      resolveProviderRuntimeExecutionTargetId({
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "ssh:host=workspace&user=root&port=22&auth=ssh-key",
      }),
    ).toBe("local");
  });
});
