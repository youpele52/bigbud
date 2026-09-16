import { describe, expect, it } from "vitest";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import {
  remoteAgentCancelEvidence,
  remoteAgentProcessTerminalEvidence,
  remoteAgentPtyTerminalEvidence,
} from "./remoteAgentTerminalEvidence.ts";
import { remoteAgentRequestDigest } from "./remoteAgentRequestDigest.ts";

describe("remote terminal evidence", () => {
  it("does not equate expired process history or a detached PTY with verified execution completion", () => {
    expect(
      remoteAgentProcessTerminalEvidence({
        requestId: "r",
        operationId: "o",
        state: "expired",
        hasExitCode: false,
        exitCode: 0,
        outputTruncated: false,
        errorCode: "AGENT_RESTARTED",
        errorMessage: "",
      }),
    ).toBe("outcome-unknown");
    expect(
      remoteAgentPtyTerminalEvidence({
        ptyId: "pty",
        hasExitCode: false,
        exitCode: 0,
        hasSignal: false,
        signal: 0,
      }),
    ).toBe("outcome-unknown");
  });
  it.each([
    [false, true, "operation-unknown-or-expired", "outcome-unknown"],
    [false, true, "operation-already-terminal", "verified-terminal"],
    [true, false, "cancellation-requested", "cancellation-requested"],
    [false, false, "operation-cannot-be-cancelled", "control-rejected"],
    [false, true, "unrecognized", "control-rejected"],
  ] as const)("classifies %s/%s/%s", (cancelled, terminal, detail, expected) => {
    expect(
      remoteAgentCancelEvidence({ requestId: "r", operationId: "o", cancelled, terminal, detail }),
    ).toBe(expected);
  });

  it("actual legacy missing-history response never permits completion or redispatch", async () => {
    let requests = 0;
    const connection = {
      request: async () => {
        requests++;
        return {
          type: "cancelResponse",
          value: {
            requestId: "r",
            operationId: "o",
            cancelled: false,
            terminal: true,
            detail: "operation-unknown-or-expired",
          },
        };
      },
    } as unknown as RemoteAgentConnection;
    await expect(
      new RemoteAgentProcessClient(connection).cancelAndWait({ operationId: "o" }),
    ).rejects.toMatchObject({ code: "PROCESS_OUTCOME_UNKNOWN" });
    expect(requests).toBe(1);
  });

  it("new request digests have fixed size and contain neither command nor file contents", () => {
    const secret = "secret-command-and-file-content";
    const digest = remoteAgentRequestDigest({ command: secret, contents: secret.repeat(1000) });
    expect(digest.byteLength).toBe(32);
    expect(Buffer.from(digest).toString()).not.toContain(secret);
    expect(digest).toEqual(
      remoteAgentRequestDigest({ command: secret, contents: secret.repeat(1000) }),
    );
  });
});
