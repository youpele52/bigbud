import { describe, expect, it, vi } from "vitest";

import { makeProofPiClient } from "./sshOwnerPickerProof.client.pi.ts";

const targetId = "ssh:host=fixture&auth=ssh-key&transport=direct-ssh";
const binary = "/opt/bigbud/pi";
const workspace = "/tmp/bigbud-provider-workspace";
const sessionFile = `${workspace}/.pi/session.jsonl`;

function recorder() {
  const operations: unknown[] = [];
  return {
    operations,
    takeChannels: () => ({
      pipes: {
        stdin: { end: vi.fn(), destroy: vi.fn(), on: vi.fn(), write: vi.fn() },
        stdout: { destroy: vi.fn(), on: vi.fn(), pipe: vi.fn() },
        stderr: { destroy: vi.fn(), on: vi.fn() },
      },
      dispose: vi.fn(),
    }),
    execute: vi.fn(async (operation: unknown) => {
      operations.push(operation);
      return { lease: new Uint8Array(32).fill(3), pid: 1, closed: false };
    }),
  };
}

describe("Pi session-file resume through the configured owner service", () => {
  it("carries the bounded session file in the start scope", async () => {
    const fixture = recorder();
    const owner = makeProofPiClient(
      targetId,
      undefined,
      binary,
      fixture.takeChannels as never,
      fixture.execute as never,
      async () => ({ status: 0, stdout: "pi v0.99.0\n", stderr: "" }),
    );
    owner.startProvider({
      provider: "pi",
      threadId: "thread-resume" as never,
      sessionEpoch: 5,
      executionTargetId: targetId,
      binaryPath: binary,
      cwd: workspace,
      sessionFile,
    });
    await vi.waitFor(() => expect(fixture.operations[0]).toMatchObject({ sessionFile }));
  });

  it("passes an out-of-workspace resume path as data so the owner can refuse it", async () => {
    const fixture = recorder();
    const owner = makeProofPiClient(
      targetId,
      undefined,
      binary,
      fixture.takeChannels as never,
      fixture.execute as never,
      async () => ({ status: 0, stdout: "1.2.3", stderr: "" }),
    );
    owner.startProvider({
      provider: "pi",
      threadId: "thread-resume" as never,
      sessionEpoch: 5,
      executionTargetId: targetId,
      binaryPath: binary,
      cwd: workspace,
      sessionFile: "/etc/passwd",
    });
    // The owner admits only a bounded path inside the workspace; the client never
    // rewrites the operand or starts a local process.
    await vi.waitFor(() =>
      expect(fixture.operations[0]).toMatchObject({ sessionFile: "/etc/passwd" }),
    );
  });
});
