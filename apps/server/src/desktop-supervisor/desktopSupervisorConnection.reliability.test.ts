import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { DesktopSupervisorConnection } from "./desktopSupervisorConnection.ts";
import { encodeDesktopSupervisorDelimitedFrame } from "./desktopSupervisorProtocol.codec.ts";
import type { DesktopSupervisorFrame } from "./desktopSupervisorProtocol.ts";

function matchesBaselineResponse(frame: DesktopSupervisorFrame): boolean {
  return frame.type === "baselineInstalled" && frame.value.recoveryId === "recovery-1";
}

function connectionFixture() {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    stdin: { end: () => void; write: (chunk: Buffer, callback: (error?: Error) => void) => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => boolean;
  };
  child.stdin = { end: vi.fn(), write: vi.fn((_chunk, callback) => callback()) };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  const connection = Reflect.construct(DesktopSupervisorConnection, [
    child,
    1_048_576,
  ]) as DesktopSupervisorConnection;
  return { child, connection };
}

describe("DesktopSupervisorConnection reliability", () => {
  it("discards a duplicate response after an ambiguous timeout retry", async () => {
    const { child, connection } = connectionFixture();
    const request: DesktopSupervisorFrame = {
      type: "installBaseline",
      value: {
        recoveryId: "recovery-1",
        consumerId: "consumer-1",
        consumerGeneration: 1,
        serverEpoch: "epoch-1",
        appliedProjectionSequence: 100,
      },
    };
    const response: DesktopSupervisorFrame = {
      type: "baselineInstalled",
      value: { ...request.value, acknowledgedSequence: 100 },
    };
    const firstController = new AbortController();
    const first = connection.request(request, matchesBaselineResponse, {
      discardResponseOnAbort: true,
      signal: firstController.signal,
    });
    firstController.abort();
    await expect(first).rejects.toThrow("cancelled");

    const retry = connection.request(request, matchesBaselineResponse);
    child.stdout.emit("data", Buffer.from(encodeDesktopSupervisorDelimitedFrame(response)));
    await expect(retry).resolves.toEqual(response);
    child.stdout.emit("data", Buffer.from(encodeDesktopSupervisorDelimitedFrame(response)));

    const finalController = new AbortController();
    const finalRequest = connection.request(request, matchesBaselineResponse, {
      signal: finalController.signal,
    });
    finalController.abort();
    await expect(finalRequest).rejects.toThrow("cancelled");
    connection.close();
  });
});
