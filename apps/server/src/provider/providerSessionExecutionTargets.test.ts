import { describe, expect, it } from "vitest";

import { resolveProviderSessionExecutionTargets } from "./providerSessionExecutionTargets.ts";

describe("resolveProviderSessionExecutionTargets", () => {
  it("defaults both targets to local", () => {
    expect(resolveProviderSessionExecutionTargets({})).toEqual({
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
      executionTargetId: "local",
    });
  });

  it("uses the legacy execution target for both targets by default", () => {
    expect(
      resolveProviderSessionExecutionTargets({
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      }),
    ).toEqual({
      providerRuntimeExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
    });
  });

  it("can keep legacy execution target as workspace-only for Pi-style sessions", () => {
    expect(
      resolveProviderSessionExecutionTargets({
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        defaultProviderRuntimeExecutionTargetId: "local",
        useLegacyExecutionTargetForProviderRuntime: false,
      }),
    ).toEqual({
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
    });
  });
});
