import { describe, expect, it } from "vitest";

import { resolveProviderRuntimeTarget } from "./providerRuntimeTarget.ts";

describe("providerRuntimeTarget", () => {
  it("resolves local runtime targets by default", () => {
    expect(resolveProviderRuntimeTarget({ executionTargetId: undefined })).toEqual({
      location: "local",
      executionTargetId: "local",
    });
  });

  it("resolves remote runtime targets from ssh execution targets", () => {
    expect(
      resolveProviderRuntimeTarget({
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      }),
    ).toEqual({
      location: "remote",
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
    });
  });
});
