import { describe, expect, it } from "vitest";
import { remoteAgentFailureDetail, remoteAgentFailureMessage } from "./remoteAgentFailure.ts";

describe("remote agent setup failure details", () => {
  it("retains the actionable failure and explains manual transport switching", () => {
    expect(remoteAgentFailureMessage(new Error("Supervisor handshake timed out"))).toContain(
      "Supervisor handshake timed out. You can switch Connection method to Direct SSH",
    );
  });
  it("does not expose remote command text or output", () => {
    const detail = remoteAgentFailureDetail(
      new Error(
        "ssh -T root@host sh -lc secret-command failed (code=1, signal=null). secret-output",
      ),
    );
    expect(detail).toContain("exit 1");
    expect(detail).not.toMatch(/secret|root@host/);
  });
  it("bounds stored details and drops multiline response bodies", () => {
    expect(remoteAgentFailureDetail(new Error("x".repeat(800)))).toHaveLength(512);
    expect(remoteAgentFailureDetail(new Error("Handshake failed\nprivate response body"))).toBe(
      "Handshake failed",
    );
  });
});
