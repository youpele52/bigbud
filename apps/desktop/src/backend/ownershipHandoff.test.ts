import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
const record = vi.hoisted(() => ({
  pid: 42,
  startedAt: "start-v2:test:1",
  machineId: "machine",
  nonce: "nonce",
}));
vi.mock("@bigbud/shared/backendOwnership.record", () => ({
  readOwnershipLock: async () => record,
}));
vi.mock("@bigbud/shared/processStartToken", () => ({
  processStartToken: () => record.startedAt,
  compareProcessStartToken: () => "same",
}));
vi.mock("node:fs/promises", () => ({ realpath: async () => "/state" }));

it.each([true, false])(
  "only quiesces and acknowledges its current child (current=%s)",
  async (current) => {
    vi.resetModules();
    const { attachOwnershipHandoff, isOwnershipHandedOff } = await import("./ownershipHandoff");
    const input = new PassThrough();
    const output = new PassThrough();
    let response = "";
    output.on("data", (data) => {
      response += String(data);
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdio: [null, null, null, null, null, null, input, output],
    }) as unknown as ChildProcess;
    const quiesce = vi.fn(() => {
      expect(response).toBe("");
    });
    attachOwnershipHandoff(child, "/state", quiesce, () => current);
    const request =
      JSON.stringify({
        operation: "a".repeat(32),
        identity: JSON.stringify([42, record.startedAt, "machine", "nonce", "/state"]),
      }) + "\n";
    input.write(request);
    await new Promise((resolve) => setImmediate(resolve));
    expect(isOwnershipHandedOff()).toBe(current);
    expect(quiesce).toHaveBeenCalledTimes(current ? 1 : 0);
    if (current)
      expect(JSON.parse(response)).toEqual({ operation: "a".repeat(32), quiesced: true });
    else expect(response).toBe("");
    response = ""; // Model an acknowledgment that never reached the backend.
    input.write(request);
    await new Promise((resolve) => setImmediate(resolve));
    if (current)
      expect(JSON.parse(response)).toEqual({ operation: "a".repeat(32), quiesced: true });
    else expect(response).toBe("");
    expect(quiesce).toHaveBeenCalledTimes(current ? 1 : 0);
    child.emit("close");
  },
);
