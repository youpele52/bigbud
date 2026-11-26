import { expect, it, vi } from "vitest";

import type { PtySequencedData } from "../terminal/Services/PTY.ts";
import type { PickerProofTerminal } from "./sshOwnerPickerProof.codec.terminal.ts";
import { makePickerProofTerminalAdapter } from "./sshOwnerPickerProof.terminalAdapter.ts";

const targetId = "proof-target";
const lease = Buffer.alloc(32, 1);
const ownerEpoch = Buffer.alloc(32, 2);
const targetGeneration = Buffer.alloc(32, 3);
const input = {
  targetId,
  pane: { threadId: "thread", terminalId: "pane" },
  cwd: "/",
  cols: 80,
  rows: 24,
};
const signal = new AbortController().signal;
const live = { lease, pid: 42, live: true, sample: Buffer.from("not a replay source") };
const chunk = (sequence: number, data: string | number[]) => ({
  sequence,
  data: typeof data === "string" ? Buffer.from(data) : Uint8Array.from(data),
});
const cut = (nextSequence: number, chunks: Array<ReturnType<typeof chunk>> = []) => ({
  lease,
  firstRetainedSequence: 1,
  nextSequence,
  chunks,
  gap: false,
});

function ownerFixture() {
  return {
    ownerEpoch,
    prepareProofTerminal: vi.fn(async () => ({ lease, ownerEpoch, targetGeneration })),
    cancelProofTerminalReservation: vi.fn(async () => {}),
    openReservedProofTerminal: vi.fn(async () => live),
    proofTerminalStatus: vi.fn(async (): Promise<PickerProofTerminal> => live),
    closeProofTerminal: vi.fn(async () => ({ ...live, live: false })),
    writeProofTerminalInput: vi.fn(async () => live),
    resizeProofTerminal: vi.fn(async () => live),
    replayProofTerminal: vi.fn(async (_lease: Uint8Array, cursor: number) => cut(cursor + 1)),
  } satisfies Parameters<typeof makePickerProofTerminalAdapter>[0];
}

async function fixture() {
  const owner = ownerFixture();
  const { port } = makePickerProofTerminalAdapter(owner, targetId);
  const binding = await port.prepareOpen(input, signal);
  const { process } = await port.open(input, binding, signal);
  return { owner, port, binding, process };
}

it.each([
  { name: "reported gap", receipt: { ...cut(1), gap: true }, error: "has a gap" },
  { name: "missing prefix", receipt: { ...cut(2), firstRetainedSequence: 2 }, error: "has a gap" },
  {
    name: "foreign lease",
    receipt: { ...cut(1), lease: Buffer.alloc(32, 9) },
    error: "does not match",
  },
  { name: "missing suffix", receipt: cut(3, [chunk(1, "one")]), error: "cut is invalid" },
  {
    name: "reordered chunks",
    receipt: cut(3, [chunk(2, "two"), chunk(1, "one")]),
    error: "cut is invalid",
  },
  {
    name: "oversized cut",
    receipt: cut(2, [chunk(1, "x".repeat(64 * 1024 + 1))]),
    error: "cut is invalid",
  },
])("rejects $name on attach without reopening or closing the PTY", async ({ receipt, error }) => {
  const { owner, port, binding, process } = await fixture();
  process.detach();
  owner.replayProofTerminal.mockResolvedValueOnce(receipt);
  await expect(port.reattach(binding, signal)).rejects.toThrow(error);
  expect(owner.openReservedProofTerminal).toHaveBeenCalledTimes(1);
  expect(owner.closeProofTerminal).not.toHaveBeenCalled();
  await expect(port.status(binding, signal)).resolves.toEqual({ binding, state: "live" });
});

it("rejects a mismatched PID before replaying the bound lease", async () => {
  const { owner, port, binding, process } = await fixture();
  process.detach();
  owner.proofTerminalStatus.mockResolvedValueOnce({ ...live, pid: live.pid + 1 });
  owner.replayProofTerminal.mockClear();
  await expect(port.reattach(binding, signal)).rejects.toThrow("does not match the proof PTY");
  expect(owner.replayProofTerminal).not.toHaveBeenCalled();
  expect(owner.openReservedProofTerminal).toHaveBeenCalledTimes(1);
});

it("decodes across the exact cut and emits no suffix from a failed live replay", async () => {
  const { owner, port, binding, process } = await fixture();
  process.detach();
  owner.replayProofTerminal
    .mockResolvedValueOnce(cut(3, [chunk(1, "before "), chunk(2, [0xe2, 0x82])]))
    .mockResolvedValueOnce(cut(4, [chunk(3, [0xac])]))
    .mockResolvedValueOnce({ ...cut(6, [chunk(5, "discard")]), gap: true });
  const { process: attached } = await port.reattach(binding, signal);
  const events: PtySequencedData[] = [];
  const text: string[] = [];
  const onError = vi.fn();
  const onExit = vi.fn();
  try {
    attached.onSequencedData?.((event) => events.push(event));
    attached.onData((data) => text.push(data));
    attached.onError?.(onError);
    attached.onExit(onExit);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("has a gap") }),
    );
    expect(events).toEqual([
      { sequence: 1, data: "before " },
      { sequence: 2, data: "" },
      { sequence: 3, data: "€" },
    ]);
    expect(text.join("")).toBe("before €");
    expect(owner.replayProofTerminal.mock.calls.map(([, cursor]) => cursor)).toEqual([0, 0, 2, 3]);
    expect(onExit).not.toHaveBeenCalled();
    expect(owner.closeProofTerminal).not.toHaveBeenCalled();
    attached.kill();
    await vi.waitFor(() => expect(owner.closeProofTerminal).toHaveBeenCalledExactlyOnceWith(lease));
    await vi.waitFor(async () =>
      expect(await port.status(binding, signal)).toMatchObject({ state: "exited" }),
    );
  } finally {
    attached.detach();
  }
});

it("does not reuse an input sequence after an unconfirmed write and reattach", async () => {
  const { owner, port, binding, process } = await fixture();
  owner.writeProofTerminalInput.mockRejectedValueOnce(new Error("receipt lost"));
  const originalError = vi.fn();
  process.onError?.(originalError);
  process.write("maybe applied");
  await vi.waitFor(() => expect(originalError).toHaveBeenCalledOnce());
  process.detach();
  const { process: attached } = await port.reattach(binding, signal);
  try {
    const attachedError = vi.fn();
    attached.onError?.(attachedError);
    attached.write("new input");
    await vi.waitFor(() => expect(attachedError).toHaveBeenCalledOnce());
    expect(owner.writeProofTerminalInput).toHaveBeenCalledExactlyOnceWith(
      lease,
      1,
      Buffer.from("maybe applied"),
    );
    expect(owner.openReservedProofTerminal).toHaveBeenCalledTimes(1);
    expect(owner.closeProofTerminal).not.toHaveBeenCalled();
  } finally {
    attached.detach();
  }
});

it.each([
  { ...live, live: false, lease: Buffer.alloc(32, 9) },
  { ...live, live: false, pid: live.pid + 1 },
  live,
])("does not release dispatch on an inexact or live close receipt (%#)", async (receipt) => {
  const { owner, port, binding, process } = await fixture();
  try {
    owner.closeProofTerminal.mockResolvedValueOnce(receipt);
    await expect(port.close(binding, signal)).rejects.toThrow();
    await expect(port.prepareOpen(input, signal)).rejects.toThrow("lease already dispatched");
    expect(owner.prepareProofTerminal).toHaveBeenCalledTimes(1);
    expect(owner.openReservedProofTerminal).toHaveBeenCalledTimes(1);
  } finally {
    process.detach();
  }
});

const durableBinding = {
  targetId,
  leaseId: lease.toString("hex"),
  ownerEpoch: ownerEpoch.toString("hex"),
  targetGeneration: targetGeneration.toString("hex"),
};

it("does not replay or close a cold route from a different birth generation", async () => {
  const owner = ownerFixture();
  const { port } = makePickerProofTerminalAdapter(owner, targetId, true);
  owner.proofTerminalStatus.mockResolvedValue({ ...live, birthGeneration: Buffer.alloc(32, 4) });
  await expect(port.reattach(durableBinding, signal)).rejects.toThrow("does not match");
  await expect(port.close(durableBinding, signal)).rejects.toThrow("does not match");
  expect(owner.replayProofTerminal).not.toHaveBeenCalled();
  expect(owner.closeProofTerminal).not.toHaveBeenCalled();
  expect(owner.openReservedProofTerminal).not.toHaveBeenCalled();
});

it("reattaches a cold exact lease but fences writes if the owner has no confirmed cursor", async () => {
  const owner = ownerFixture();
  const { port } = makePickerProofTerminalAdapter(owner, targetId, true);
  owner.proofTerminalStatus.mockResolvedValue({ ...live, birthGeneration: targetGeneration });
  const attachment = await port.reattach(durableBinding, signal);
  expect(attachment).toMatchObject({ binding: durableBinding, recoveredHistoryFromStart: true });
  try {
    const error = vi.fn();
    attachment.process.onError?.(error);
    attachment.process.write("never replay");
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(owner.writeProofTerminalInput).not.toHaveBeenCalled();
    expect(owner.openReservedProofTerminal).not.toHaveBeenCalled();
  } finally {
    attachment.process.detach();
  }
});

it("drains an in-flight poll on detach without delivering its bytes or killing the PTY", async () => {
  const { owner, port, binding, process } = await fixture();
  const late = Promise.withResolvers<ReturnType<typeof cut>>();
  owner.replayProofTerminal.mockImplementationOnce(() => late.promise);
  const oldOutput = vi.fn();
  process.onData(oldOutput);
  await vi.waitFor(() => expect(owner.replayProofTerminal).toHaveBeenCalledTimes(2));
  process.detach();
  owner.replayProofTerminal.mockResolvedValueOnce(cut(2, [chunk(1, "late")]));
  const reattaching = port.reattach(binding, signal);
  expect(owner.proofTerminalStatus).not.toHaveBeenCalled();
  late.resolve(cut(2, [chunk(1, "late")]));
  const { process: attached } = await reattaching;
  try {
    const newOutput = vi.fn();
    attached.onData(newOutput);
    await vi.waitFor(() => expect(newOutput).toHaveBeenCalledExactlyOnceWith("late"));
    expect(oldOutput).not.toHaveBeenCalled();
    expect(owner.openReservedProofTerminal).toHaveBeenCalledTimes(1);
    expect(owner.closeProofTerminal).not.toHaveBeenCalled();
  } finally {
    attached.detach();
  }
});
