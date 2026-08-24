import { describe, expect, it } from "vitest";

import { supportsWorkspaceDirectoryWatch } from "./workspaceWatchCapability";

describe("supportsWorkspaceDirectoryWatch", () => {
  it("keeps local watching enabled without an agent capability snapshot", () => {
    expect(supportsWorkspaceDirectoryWatch("local", undefined)).toBe(true);
  });

  it("does not enable remote watching before the capability snapshot arrives", () => {
    expect(supportsWorkspaceDirectoryWatch("ssh:host=devbox", undefined)).toBe(false);
  });

  it("keeps remote watching disabled when the agent does not advertise it", () => {
    expect(
      supportsWorkspaceDirectoryWatch("ssh:host=devbox", {
        remoteAgent: {
          enabled: true,
          supportsDirectoryWatch: false,
          supportsPtyReattach: false,
        },
      }),
    ).toBe(false);
  });

  it("enables remote watching only when the agent advertises it", () => {
    expect(
      supportsWorkspaceDirectoryWatch("ssh:host=devbox", {
        remoteAgent: {
          enabled: true,
          supportsDirectoryWatch: true,
          supportsPtyReattach: true,
        },
      }),
    ).toBe(true);
  });
});
