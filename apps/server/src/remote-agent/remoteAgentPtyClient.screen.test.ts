import { describe, expect, it } from "vitest";
import type { RemoteAgentPtyScreenSnapshotChunk } from "./remoteAgentProtocol.ptyLifecycle.ts";
import { RemoteAgentScreenAssembly } from "./remoteAgentPtyClient.screen.ts";
import { bytesOf, snapshotHeader } from "./remoteAgentPtyClient.lifecycle.testUtils.ts";

const KiB = 1024;
const chunk = (index: number, bytes: Uint8Array, last: boolean) =>
  ({ requestId: "r", index, last, bytes }) satisfies RemoteAgentPtyScreenSnapshotChunk;

function assemble(ansi: Uint8Array, chunkSize: number) {
  const count = Math.ceil(ansi.length / chunkSize);
  const assembly = new RemoteAgentScreenAssembly(snapshotHeader("r", ansi, count), "pty-1");
  const chunks = Array.from({ length: count }, (_, index) =>
    chunk(index, ansi.subarray(index * chunkSize, (index + 1) * chunkSize), index === count - 1),
  );
  return { assembly, chunks };
}

describe("screen snapshot reassembly", () => {
  it("reassembles the maximum transfer: 16 chunks of 192 KiB, 3 MiB, verified by SHA-256", () => {
    const ansi = bytesOf(3 * 1024 * KiB);
    const { assembly, chunks } = assemble(ansi, 192 * KiB);
    expect(chunks).toHaveLength(16);
    for (const part of chunks.slice(0, -1)) expect(assembly.accept(part)).toBeUndefined();
    const snapshot = assembly.accept(chunks.at(-1)!);
    expect(Buffer.from(snapshot!.ansi).equals(Buffer.from(ansi))).toBe(true);
    expect(snapshot).toMatchObject({
      throughSequence: 41,
      cols: 120,
      rows: 40,
      fidelity: "full",
      modelState: "live",
    });
    expect(snapshot!.pendingEscapeTail).toEqual(new Uint8Array([0x1b]));
  });

  it("completes an empty screen with no chunks", () => {
    const assembly = new RemoteAgentScreenAssembly(
      snapshotHeader("r", new Uint8Array(), 0),
      "pty-1",
    );
    expect(assembly.snapshot?.ansi).toHaveLength(0);
  });

  it("rejects out-of-order and duplicate chunks", () => {
    const { assembly, chunks } = assemble(bytesOf(30), 10);
    expect(() => assembly.accept(chunks[1]!)).toThrow("Expected snapshot chunk 0, received 1");
    const second = assemble(bytesOf(30), 10);
    second.assembly.accept(second.chunks[0]!);
    expect(() => second.assembly.accept(second.chunks[0]!)).toThrow("duplicate");
  });

  it("rejects chunks after the last one", () => {
    const { assembly, chunks } = assemble(bytesOf(20), 10);
    assembly.accept(chunks[0]!);
    assembly.accept(chunks[1]!);
    expect(() => assembly.accept(chunk(2, bytesOf(1), true))).toThrow("after the last chunk");
  });

  it("rejects an oversize chunk and bytes beyond the declared total", () => {
    const big = bytesOf(192 * KiB + 1);
    const header = snapshotHeader("r", big, 2);
    const assembly = new RemoteAgentScreenAssembly(header, "pty-1");
    expect(() => assembly.accept(chunk(0, big, false))).toThrow("oversize");
    const small = assemble(bytesOf(10), 5);
    expect(() => small.assembly.accept(chunk(0, bytesOf(11), false))).toThrow("oversize");
  });

  it("rejects a last flag that disagrees with the chunk count", () => {
    const { assembly, chunks } = assemble(bytesOf(20), 10);
    expect(() => assembly.accept({ ...chunks[0]!, last: true })).toThrow("chunk count");
  });

  it("rejects a digest or length mismatch", () => {
    const ansi = bytesOf(20);
    const bad = new RemoteAgentScreenAssembly(
      snapshotHeader("r", ansi, 2, { sha256: new Uint8Array(32) }),
      "pty-1",
    );
    bad.accept(chunk(0, ansi.subarray(0, 10), false));
    expect(() => bad.accept(chunk(1, ansi.subarray(10), true))).toThrow("digest");
    const short = new RemoteAgentScreenAssembly(snapshotHeader("r", ansi, 2), "pty-1");
    short.accept(chunk(0, ansi.subarray(0, 10), false));
    expect(() => short.accept(chunk(1, ansi.subarray(10, 15), true))).toThrow("shorter");
  });

  it.each([
    ["more than 16 chunks", { chunkCount: 17 }],
    ["more than 3 MiB", { totalAnsiBytes: 3 * 1024 * KiB + 1, chunkCount: 16 }],
    ["more bytes than the chunks can carry", { totalAnsiBytes: 192 * KiB + 1, chunkCount: 1 }],
    ["an oversize escape tail", { pendingEscapeTail: new Uint8Array(16 * KiB + 1) }],
    ["a malformed digest", { sha256: new Uint8Array(31) }],
    ["an unknown fidelity", { fidelity: "lossy" }],
    ["an unknown model state", { modelState: "stale" }],
    ["zero columns", { cols: 0 }],
    ["another terminal", { ptyId: "pty-2" }],
  ])("rejects a header with %s", (_name, overrides) => {
    expect(
      () => new RemoteAgentScreenAssembly(snapshotHeader("r", bytesOf(10), 1, overrides), "pty-1"),
    ).toThrow(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));
  });
});
