import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./backendStartupState", () => ({
  recordBackendStartupProgress: vi.fn(),
  recordBackendStartupStatus: vi.fn(),
}));

import {
  attachBackendLifecycleHintPipe,
  BackendLifecycleHintPipe,
  detachBackendLifecycleHintPipe,
  writeBackendLifecycleHint,
  writeBackendQuitHint,
} from "./backendLifecycleHintPipe";
import { listenForBackendStartupStatus } from "./backendStartupStatusPipe";

function capture(stream: PassThrough): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    for (const line of chunk.split("\n").filter(Boolean)) lines.push(JSON.parse(line));
  });
  return lines;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("quit hint", () => {
  it("shares the power hints' sequence and repeats the latest online state", () => {
    const stream = new PassThrough();
    const lines = capture(stream);
    const pipe = new BackendLifecycleHintPipe(stream, { platform: "darwin", log: vi.fn() });
    pipe.write({ kind: "offline", occurredAt: 1, online: false });
    expect(pipe.writeQuit("update", 2)).toBe(2);
    expect(lines[1]).toEqual({
      kind: "quit",
      sequence: 2,
      occurredAt: 2,
      online: false,
      reason: "update",
    });
  });

  it("resolves the ack wait on ack, timeout or backend exit", async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const pipe = new BackendLifecycleHintPipe(stream, { platform: "darwin", log: vi.fn() });
    const acked = pipe.waitForAck(pipe.writeQuit("quit")!, 1_500);
    pipe.acknowledge(1);
    await expect(acked).resolves.toBe(true);

    const timedOut = pipe.waitForAck(pipe.writeQuit("quit")!, 1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(timedOut).resolves.toBe(false);

    const closed = pipe.waitForAck(pipe.writeQuit("quit")!, 1_500);
    stream.destroy();
    await vi.advanceTimersByTimeAsync(0);
    await expect(closed).resolves.toBe(false);
    expect(pipe.writeQuit("quit")).toBeNull();
  });

  it("routes the server's ack record from the status pipe to the running backend's pipe", async () => {
    const hintStream = new PassThrough();
    const lines = capture(hintStream);
    const pipe = attachBackendLifecycleHintPipe(hintStream, { platform: "darwin", log: vi.fn() });
    const statusStream = new PassThrough();
    const onInvalid = vi.fn();
    listenForBackendStartupStatus(statusStream, 3, onInvalid);

    const quit = writeBackendQuitHint("quit")!;
    expect(lines[0]).toMatchObject({ kind: "quit", sequence: 1, reason: "quit" });
    const acknowledged = quit.acknowledged(1_500);
    statusStream.write('{"lifecycleHintAck":{"sequence":"x"}}\n');
    expect(onInvalid).toHaveBeenCalledWith("malformed lifecycle hint ack");
    statusStream.write('{"lifecycleHintAck":{"sequence":1}}\n');
    await expect(acknowledged).resolves.toBe(true);

    detachBackendLifecycleHintPipe(pipe);
    expect(writeBackendQuitHint("quit")).toBeNull();
    expect(writeBackendLifecycleHint({ kind: "online", occurredAt: 1, online: true })).toBe(false);
  });
});
