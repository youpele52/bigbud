import { describe, expect, it } from "vitest";

import { WsTransportDisconnectedError } from "../rpc/wsTransport.errors";
import {
  isRetryableWorkspaceError,
  workspaceErrorDetails,
  workspaceErrorSummary,
} from "./workspaceRequestRecovery.errors";

describe("workspace recovery error classification", () => {
  it.each([
    "mux_client_request_session: session request failed: Session open refused by peer",
    "Connection reset by peer",
    "ssh: connect to host vps port 22: Connection refused",
    "remote agent disconnected",
    "Remote agent connection is closed.",
    "ssh -T vps 'find .' timed out.",
    "ssh failed (code=255, signal=null). Warning: Identity file key not accessible: No such file or directory.\nSession request failed: Session open refused by peer",
    "transport closed",
    "EPIPE",
  ])("retries temporary transport failure: %s", (message) => {
    expect(isRetryableWorkspaceError(new Error(message))).toBe(true);
  });

  it.each([
    "ssh failed (code=255, signal=null)",
    "Permission denied (publickey). Connection closed",
    "Host key verification failed. Connection closed",
    "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! Connection reset",
    "ENOENT: no such file or directory",
    "workspace path contains a symlink component",
    "Invalid execution target",
    "remote agent install source is unavailable (HTTP 404)",
    "ssh -T vps 'echo Connection reset' failed (code=255, signal=null). Unknown failure",
  ])("does not conceal actionable/unknown failure: %s", (message) => {
    expect(isRetryableWorkspaceError(new Error(message))).toBe(false);
  });

  it("uses structured transport/retryability information", () => {
    expect(isRetryableWorkspaceError(new WsTransportDisconnectedError())).toBe(true);
    expect(isRetryableWorkspaceError({ retryable: false, message: "Connection reset" })).toBe(
      false,
    );
    expect(isRetryableWorkspaceError({ retryable: true, message: "Disconnected" })).toBe(true);
  });

  it.each([
    ["Permission denied (publickey).", "SSH authentication"],
    ["Host key verification failed.", "SSH host key"],
    ["EACCES: permission denied", "don’t have permission"],
    ["ENOENT: no such file or directory", "path could not be found"],
  ])("keeps actionable failures clear without exposing raw diagnostics: %s", (message, summary) => {
    expect(workspaceErrorSummary(new Error(message))).toContain(summary);
  });

  it("does not expose shell commands from SSH spawn failures", () => {
    expect(
      workspaceErrorDetails(
        new Error(
          "Failed to list workspace directory: Failed to run ssh -T vps 'export PRIVATE_KEY=value; find .': spawn EACCES",
        ),
      ),
    ).toBe("The remote SSH command could not complete.");
  });

  it("redacts quoted credentials and authorization headers", () => {
    expect(
      workspaceErrorDetails(
        'password="several secret words" Authorization: Bearer abc123 API_KEY=value PRIVATE_KEY=private',
      ),
    ).toBe(
      "password=[redacted] Authorization=[redacted] API_KEY=[redacted] PRIVATE_KEY=[redacted]",
    );
  });

  it("omits shell commands from timeout diagnostics", () => {
    expect(
      workspaceErrorDetails(new Error("ssh -T vps 'export PRIVATE_KEY=secret; find .' timed out.")),
    ).toBe("Remote command timed out. ");
  });

  it("omits the SSH shell command and redacts connection secrets from technical details", () => {
    const details = workspaceErrorDetails(
      new Error(
        "Failed to list workspace directory: ssh -T vps 'export PRIVATE_KEY=secret; find .' failed (code=255, signal=null). session request failed token=secret https://host/?token=other",
      ),
    );
    expect(details).toContain("session request failed");
    expect(details).not.toContain("ssh -T");
    expect(details).not.toContain("PRIVATE_KEY");
    expect(details).not.toContain("secret");
    expect(details).not.toContain("other");
    expect(details).toContain("token=[redacted]");
  });
});
