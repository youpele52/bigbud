import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

import { RemoteAgentConnection } from "./remoteAgentConnection";
import { encodeDelimitedFrame } from "./remoteAgentProtocol.codec";
import type { RemoteAgentFrame } from "./remoteAgentProtocol";

const fakeChild = () => {
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_bytes: Uint8Array, done: () => void) => {
      done();
      return true;
    }),
    end: vi.fn(),
  });
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
};

const reply = (requestId: string): RemoteAgentFrame => ({
  type: "ptySignalResponse",
  value: { requestId, ptyId: "pty", accepted: true, errorCode: "", errorMessage: "" },
});

it("keeps unclaimed frames up to the cap, then fails the connection visibly", async () => {
  const child = fakeChild();
  const Connection = RemoteAgentConnection as unknown as new (
    child: unknown,
    limit: number,
    maxUnclaimedFrames: number,
  ) => RemoteAgentConnection;
  const connection = new Connection(child, 4096, 8);
  const unclaimed = () =>
    (connection as unknown as { inbox: { unclaimedCount: number } }).inbox.unclaimedCount;
  const emit = (frame: RemoteAgentFrame) =>
    child.stdout.emit("data", Buffer.from(encodeDelimitedFrame(frame, 4096)));
  const failures: Array<Error> = [];
  connection.onFailure((error) => failures.push(error));

  for (let index = 0; index < 8; index += 1) emit(reply(`r${index}`));
  expect(unclaimed()).toBe(8);
  // A reply collected later is still there: nothing was dropped below the cap.
  await expect(
    connection.request(
      reply("ignored"),
      (frame) => frame.type === "ptySignalResponse" && frame.value.requestId === "r3",
    ),
  ).resolves.toMatchObject({ value: { requestId: "r3" } });
  expect(unclaimed()).toBe(7);

  const pending = connection.nextFrame((frame) => frame.type === "agentHello");
  emit(reply("r8"));
  emit(reply("r9"));
  expect(unclaimed()).toBe(8);
  expect(failures).toHaveLength(1);
  expect(failures[0]!.message).toContain("unclaimed frames");
  await expect(pending).rejects.toThrow("unclaimed frames");
  expect(child.stdin.end).toHaveBeenCalled();
});

const lifecycleFrame = (index: number): RemoteAgentFrame => {
  if (index % 3 === 0)
    return {
      type: "ptyActivity",
      value: {
        ptyId: "pty",
        idleBusy: false,
        pressureBusy: false,
        sidebarBusy: true,
        reasons: ["output"],
        lastInputMs: 0,
        lastOutputMs: index,
        quietSinceMs: 0,
      },
    };
  if (index % 3 === 1)
    return {
      type: "ptyLifecycleNotice",
      value: {
        noticeId: index,
        ptyId: "pty",
        kind: "idle_warning",
        closesAtMs: 1,
        occurredAtMs: 0,
      },
    };
  return {
    type: "hostResourceReport",
    value: {
      sampledAtMs: index,
      memoryLevel: "normal",
      memoryAvailableBytes: 1,
      memoryTotalBytes: 2,
      hostRssBytes: 3,
      terminalRssBytes: 4,
      screenModelBytes: 5,
      spoolBytes: 6,
      livePtys: 1,
      managedLivePtys: 1,
      maxLivePtys: 24,
    },
  };
};

it("drops unsolicited lifecycle frames nobody claims, but still delivers them to listeners", () => {
  const child = fakeChild();
  const Connection = RemoteAgentConnection as unknown as new (
    child: unknown,
    limit: number,
  ) => RemoteAgentConnection;
  // Default unclaimed cap (1,024): 2,000 frames would close the connection if they were kept.
  const connection = new Connection(child, 4096);
  const unclaimed = () =>
    (connection as unknown as { inbox: { unclaimedCount: number } }).inbox.unclaimedCount;
  const emit = (frame: RemoteAgentFrame) =>
    child.stdout.emit("data", Buffer.from(encodeDelimitedFrame(frame, 4096)));
  const failures: Array<Error> = [];
  connection.onFailure((error) => failures.push(error));

  for (let index = 0; index < 2_000; index += 1) emit(lifecycleFrame(index));
  expect(unclaimed()).toBe(0);
  expect(failures).toHaveLength(0);
  expect(child.stdin.end).not.toHaveBeenCalled();

  const received: string[] = [];
  const remove = connection.onFrame((frame) => {
    received.push(frame.type);
  });
  for (let index = 0; index < 3; index += 1) emit(lifecycleFrame(index));
  remove();
  expect(received).toEqual(["ptyActivity", "ptyLifecycleNotice", "hostResourceReport"]);
  expect(unclaimed()).toBe(0);
  expect(failures).toHaveLength(0);
});
