import { describe, expect, it } from "vitest";

import { getRemoteAgentAccessError } from "./useRemoteExecutionAccessGate.shared";

describe("getRemoteAgentAccessError", () => {
  it("directs users to approve a required installation", () => {
    expect(getRemoteAgentAccessError({ status: "install-required" })).toContain(
      "approve installation",
    );
  });

  it("includes the version transition for a required upgrade", () => {
    expect(
      getRemoteAgentAccessError({
        status: "upgrade-required",
        currentVersion: "0.1.0",
        targetVersion: "0.2.0",
      }),
    ).toBe(
      "The bigbud remote agent must be upgraded from 0.1.0 to 0.2.0. Edit the remote project to review and approve the upgrade.",
    );
  });

  it("allows ready and disabled agent states", () => {
    expect(getRemoteAgentAccessError({ status: "ready", version: "0.2.0" })).toBeNull();
    expect(getRemoteAgentAccessError({ status: "disabled" })).toBeNull();
  });
});
