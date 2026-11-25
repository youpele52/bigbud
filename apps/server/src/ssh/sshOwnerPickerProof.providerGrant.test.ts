import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  spawnMock.mockImplementation(() => {
    throw new Error("no legacy SSH spawn is allowed for an owner provider service");
  });
  return { ...actual, spawn: spawnMock };
});

import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { makeProofPiClient } from "./sshOwnerPickerProof.client.pi.ts";
import { makeProofOpencodeOwner } from "./sshOwnerPickerProof.client.opencode.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

const targetId = "ssh:host=fixture&auth=ssh-key&transport=direct-ssh";
const binary = "/opt/bigbud/pi";
const workspace = "/tmp/bigbud-provider-workspace";
const threadId = ThreadId.makeUnsafe("thread-provider-service");
const lease = new Uint8Array(32).fill(7);
const binding = () => ({
  ownerEpoch: new Uint8Array(32).fill(1),
  targetGeneration: new Uint8Array(32).fill(2),
});

function duplexRecorder() {
  const operations: unknown[] = [];
  const takeChannels = () => ({
    pipes: {
      stdin: { end: vi.fn(), destroy: vi.fn(), on: vi.fn(), write: vi.fn() } as never,
      stdout: { destroy: vi.fn(), on: vi.fn(), pipe: vi.fn() } as never,
      stderr: { destroy: vi.fn(), on: vi.fn() } as never,
    },
    dispose: vi.fn(),
  });
  const execute = vi.fn(async (operation: unknown) => {
    operations.push(operation);
    return { lease, pid: 1, closed: true };
  });
  return { takeChannels, execute: execute as never, operations };
}

describe("selected provider service grants", () => {
  it("starts Pi through the configured remote executable with the resume path", async () => {
    const recorder = duplexRecorder();
    const owner = makeProofPiClient(
      targetId,
      undefined,
      binary,
      recorder.takeChannels as never,
      recorder.execute,
      async () => ({ status: 0, stdout: "pi v0.99.0\n", stderr: "" }),
    );
    const runtime = {
      provider: "pi" as const,
      threadId,
      sessionEpoch: 3,
      executionTargetId: targetId,
      binaryPath: binary,
      cwd: workspace,
      sessionFile: `${workspace}/.pi/session.jsonl`,
    };
    expect(await owner.probeProvider(runtime, new AbortController().signal)).toBe("pi v0.99.0\n");
    owner.startProvider(runtime);
    await vi.waitFor(() => expect(recorder.operations).toHaveLength(1));
    expect(recorder.operations[0]).toMatchObject({
      kind: "openProofPi",
      threadId,
      sessionEpoch: 3,
      cwd: workspace,
      binaryPath: binary,
      sessionFile: `${workspace}/.pi/session.jsonl`,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a different target and a different executable", async () => {
    const recorder = duplexRecorder();
    const owner = makeProofPiClient(
      targetId,
      undefined,
      binary,
      recorder.takeChannels as never,
      recorder.execute,
      async () => ({ status: 0, stdout: "1.2.3", stderr: "" }),
    );
    const runtime = {
      provider: "pi" as const,
      threadId,
      sessionEpoch: 3,
      executionTargetId: "ssh:host=other&transport=direct-ssh",
      binaryPath: binary,
      cwd: workspace,
    };
    await expect(owner.probeProvider(runtime, new AbortController().signal)).rejects.toBeInstanceOf(
      PickerProofOwnerError,
    );
    await expect(
      owner.probeProvider(
        { ...runtime, executionTargetId: targetId, binaryPath: "/usr/bin/env" },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(PickerProofOwnerError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("keeps the proof binding refusing a resume operand without a product service", () => {
    const recorder = duplexRecorder();
    const owner = makeProofPiClient(
      targetId,
      undefined,
      undefined,
      recorder.takeChannels as never,
      recorder.execute,
      async () => ({ status: 0, stdout: "1.2.3", stderr: "" }),
    );
    expect(() =>
      owner.startProvider({
        provider: "pi",
        threadId,
        sessionEpoch: 3,
        executionTargetId: targetId,
        binaryPath: binary,
        cwd: workspace,
        sessionFile: `${workspace}/.pi/session.jsonl`,
      }),
    ).toThrow(PickerProofOwnerError);
  });

  it("starts OpenCode with an owner-selected listener and no caller forward spec", () => {
    const recorder = duplexRecorder();
    const owner = makeProofOpencodeOwner(
      targetId,
      undefined,
      "/opt/bigbud/opencode",
      binding,
      recorder.execute,
    );
    const start = owner.startProvider({
      provider: "opencode",
      threadId,
      sessionEpoch: 2,
      executionTargetId: targetId,
      cwd: workspace,
      binaryPath: "/opt/bigbud/opencode",
    });
    expect(start.lease.leaseId).toMatch(/^[a-f0-9]{64}$/);
    const open = recorder.operations[0] as Record<string, unknown>;
    expect(open).toMatchObject({
      kind: "proofOpencodeOpen",
      serviceScope: { threadId, sessionEpoch: 2, cwd: workspace },
    });
    expect(open).not.toHaveProperty("binaryPath");
    expect(open).not.toHaveProperty("forward");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses an OpenCode target mismatch", () => {
    const recorder = duplexRecorder();
    const owner = makeProofOpencodeOwner(
      targetId,
      undefined,
      "/opt/bigbud/opencode",
      binding,
      recorder.execute,
    );
    expect(() =>
      owner.startProvider({
        provider: "opencode",
        threadId,
        sessionEpoch: 2,
        executionTargetId: "ssh:host=other&transport=direct-ssh",
        cwd: workspace,
        binaryPath: "/opt/bigbud/opencode",
      }),
    ).toThrow(PickerProofOwnerError);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
