import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { RemoteAgentPtyInventory } from "./remoteAgentPtyInventory.ts";
import {
  RemoteAgentConnectionPool,
  type RemoteAgentRuntimeBinding,
} from "./remoteAgentConnectionPool.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentPtyListResponse } from "./remoteAgentProtocol.pty.ts";
import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";

const entry = {
  ptyId: "pty-1",
  requestDigest: new Uint8Array([1, 2]),
  state: "running",
  pid: 42,
  nextSequence: 2,
  firstRetainedSequence: 1,
  verifiedExit: false,
  launchStatus: "unconfirmed",
};
const response: RemoteAgentPtyListResponse = {
  requestId: "list-1",
  agentEpoch: "epoch-1",
  entries: [entry],
  nextAfterPtyId: "",
  snapshotId: "a".repeat(64),
  accepted: true,
  errorCode: "",
};
const binding: RemoteAgentRuntimeBinding = {
  expectedEpoch: "epoch-1",
  runtime: {
    generation: "gen-1",
    version: "0.1.0",
    sha256: "a".repeat(64),
    buildDigest: "digest",
    targetTriple: "aarch64-unknown-linux-gnu",
    origin: "managed",
    binaryPath: "/bin/agent",
    statePath: "/state",
    socketPath: "/state/supervisor.sock",
    logPath: "/state/log",
  },
};
function fixture(pages: Partial<RemoteAgentPtyListResponse>[]) {
  const request = vi.fn(async (frame: RemoteAgentFrame) => {
    if (frame.type !== "ptyListRequest") throw new Error("Only inventory may be sent");
    return {
      type: "ptyListResponse",
      value: { ...response, ...pages.shift(), requestId: frame.value.requestId },
    };
  });
  const getBound = vi.fn(async () => ({ request }) as unknown as RemoteAgentConnection);
  return { client: new RemoteAgentPtyInventory({ getBound }), request, getBound };
}

describe("bounded PTY inventory", () => {
  it("matches shared Rust request/response goldens", () => {
    const goldens = Object.fromEntries(
      readFileSync(
        new URL("../../../../protocol/remote-agent/v1.golden.frames", import.meta.url),
        "utf8",
      )
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => line.split("=")),
    );
    const frames: [string, RemoteAgentFrame][] = [
      [
        "pty_list_request",
        {
          type: "ptyListRequest",
          value: {
            requestId: "list-1",
            expectedEpoch: "epoch-1",
            afterPtyId: "",
            limit: 100,
            snapshotId: "",
          },
        },
      ],
      ["pty_list_response", { type: "ptyListResponse", value: response }],
    ];
    for (const [name, frame] of frames) {
      const bytes = Uint8Array.from(Buffer.from(goldens[name]!, "hex"));
      expect(encodeDelimitedFrame(frame)).toEqual(bytes);
      expect(decodeDelimitedFrame(bytes)).toEqual(frame);
    }
  });
  it("uses pinned capability acquisition and paginates without any launch", async () => {
    const f = fixture([{ nextAfterPtyId: "pty-1" }, { entries: [{ ...entry, ptyId: "pty-2" }] }]);
    expect(await f.client.list("ssh:host", binding)).toHaveLength(2);
    expect(f.getBound).toHaveBeenCalledWith("ssh:host", binding, ["terminal.pty-inventory"]);
    expect(f.request.mock.calls[1]?.[0]).toMatchObject({
      value: { afterPtyId: "pty-1", snapshotId: response.snapshotId, limit: 100 },
    });
  });
  it("discards incomplete scans and retries membership changes at most three times", async () => {
    const f = fixture(
      Array.from({ length: 3 }, () => ({ accepted: false, errorCode: "PTY_INVENTORY_CHANGED" })),
    );
    await expect(f.client.list("ssh:host", binding)).rejects.toThrow("changed during discovery");
    expect(f.request).toHaveBeenCalledTimes(3);
  });
  it.each([
    { agentEpoch: "old" },
    { entries: [entry, entry] },
    { nextAfterPtyId: "stuck" },
    { entries: [{ ...entry, verifiedExit: true }] },
    { snapshotId: "invalid" },
    { entries: [{ ...entry, firstRetainedSequence: 3 }] },
    {
      entries: Array.from({ length: 65 }, (_, n) => ({
        ...entry,
        ptyId: `pty-${String(n).padStart(3, "0")}`,
      })),
    },
  ])("rejects inconsistent inventory %#", async (page) => {
    const f = fixture([page]);
    await expect(f.client.list("ssh:host", binding)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("retains unknown launches without verified exit", async () => {
    const f = fixture([
      {
        entries: [
          { ...entry, state: "outcome-unknown", pid: 0, nextSequence: 0, firstRetainedSequence: 0 },
        ],
      },
    ]);
    expect((await f.client.list("ssh:host", binding))[0]).toMatchObject({
      state: "outcome-unknown",
      verifiedExit: false,
    });
  });
  it("refuses old agents before dispatch using the real pool", async () => {
    const request = vi.fn();
    const pool = new RemoteAgentConnectionPool({
      create: async () =>
        ({
          request,
          close: vi.fn(),
          handshake: async () => ({
            protocolMajor: 1,
            protocolMinor: 5,
            agentVersion: "0.1.0",
            buildDigest: "digest",
            os: "linux",
            architecture: "aarch64",
            agentInstanceId: "instance",
            agentEpoch: "epoch-1",
            capabilities: [],
            maxFrameBytes: 1024,
            maxOperationOutputBytes: 1024,
            maxJournalBytes: 1024,
          }),
        }) as unknown as RemoteAgentConnection,
    });
    await expect(new RemoteAgentPtyInventory(pool).list("ssh:host", binding)).rejects.toThrow(
      "terminal.pty-inventory",
    );
    expect(request).not.toHaveBeenCalled();
    pool.closeAll();
  });
  it("rejects oversized pages at the wire decoder", () => {
    const bytes = encodeDelimitedFrame({
      type: "ptyListResponse",
      value: { ...response, entries: Array.from({ length: 101 }, () => entry) },
    });
    expect(() => decodeDelimitedFrame(bytes)).toThrow("100 entries");
  });
});

describe("inventory acquisition cancellation", () => {
  it.each(["caller", "deadline"])(
    "bounds pending acquisition on %s without closing shared transport",
    async (kind) => {
      const controller = new AbortController();
      const timeout =
        kind === "deadline"
          ? vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal)
          : undefined;
      const request = vi.fn();
      const close = vi.fn();
      let release!: (connection: RemoteAgentConnection) => void;
      const getBound = vi.fn(
        () =>
          new Promise<RemoteAgentConnection>((resolve) => {
            release = resolve;
          }),
      );
      try {
        const pending = new RemoteAgentPtyInventory({ getBound }).list(
          "ssh:host",
          binding,
          kind === "caller" ? controller.signal : undefined,
        );
        const assertion = expect(pending).rejects.toThrow("inventory cancelled");
        controller.abort(new Error("inventory cancelled"));
        await assertion;
        if (timeout) expect(timeout).toHaveBeenCalledWith(10_000);
        release({ request, close } as unknown as RemoteAgentConnection);
        await Promise.resolve();
        expect(request).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
      } finally {
        timeout?.mockRestore();
      }
    },
  );
  it("discards already accumulated entries when the second page changes membership", async () => {
    const f = fixture([
      { nextAfterPtyId: "pty-1" },
      { accepted: false, errorCode: "PTY_INVENTORY_CHANGED" },
      { entries: [{ ...entry, ptyId: "pty-new" }] },
    ]);
    expect((await f.client.list("ssh:host", binding)).map((value) => value.ptyId)).toEqual([
      "pty-new",
    ]);
    expect(f.request.mock.calls[2]?.[0]).toMatchObject({
      value: { afterPtyId: "", snapshotId: "" },
    });
  });
});
