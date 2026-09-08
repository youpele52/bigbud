import { describe, expect, it } from "vitest";
import { ProjectDirectoryWatchError } from "@bigbud/contracts/workspace/project";

import {
  shouldRetryWorkspaceDirectoryWatch,
  supportsWorkspaceDirectoryWatch,
} from "./workspaceWatchCapability";

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

  it("enables the direct-SSH polling fallback without the managed agent", () => {
    expect(
      supportsWorkspaceDirectoryWatch("ssh:host=devbox", {
        remoteAgent: {
          enabled: false,
          supportsDirectoryWatch: true,
          supportsPtyReattach: false,
        },
      }),
    ).toBe(true);
  });
});

describe("shouldRetryWorkspaceDirectoryWatch", () => {
  it("stops retrying explicitly unavailable watches", () => {
    expect(
      shouldRetryWorkspaceDirectoryWatch(
        new ProjectDirectoryWatchError({ message: "unsupported", retryable: false }),
      ),
    ).toBe(false);
    expect(shouldRetryWorkspaceDirectoryWatch(new Error("connection lost"))).toBe(true);
  });
});
