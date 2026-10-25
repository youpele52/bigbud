import { describe, expect, it } from "vitest";

import {
  getRemoteAgentAccessError,
  resolveRemoteExecutionFailureStatus,
} from "./useRemoteExecutionAccessGate.shared";

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

  it("keeps host trust actionable without showing the encoded challenge in status text", () => {
    const message = `SSH host trust is required: ${JSON.stringify({ challengeId: "a", host: "box", keyType: "ED25519", fingerprint: "SHA256:abc" })}`;
    expect(resolveRemoteExecutionFailureStatus(message)).toMatchObject({
      status: "auth_required",
      authMode: "host-trust",
      promptLabel: message,
      message: "SSH server identity confirmation is required.",
    });
  });
});
