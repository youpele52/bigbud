import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { organizerChildren, qualificationEnvironment } from "./inyosira-qualification.process.ts";
import { requestRpc } from "./inyosira-qualification.rpc.ts";
import { assertDeadlineObservation } from "./inyosira-qualification.scenario.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("isolates profiles and excludes credentials and inherited overrides", () => {
  vi.stubEnv("OPENAI_API_KEY", "must-not-propagate");
  vi.stubEnv("NODE_OPTIONS", "--require unexpected-hook");
  vi.stubEnv("BIGBUD_HOME", "live-userdata");
  vi.stubEnv("BIGBUD_AUTH_TOKEN", "live-token");
  vi.stubEnv("BIGBUD_DESKTOP_SUPERVISOR_BINARY", "wrong-binary");
  const env = qualificationEnvironment("qualification", "packaged-supervisor");
  expect(env.BIGBUD_HOME).toBe(join("qualification", "state"));
  expect(env.HOME).toBe(join("qualification", "home"));
  expect(env.USERPROFILE).toBe(env.HOME);
  expect(env.BIGBUD_DESKTOP_SUPERVISOR_BINARY).toBe("packaged-supervisor");
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(env.BIGBUD_AUTH_TOKEN).toBeUndefined();
});

it("requires the exact packaged native path and direct backend parent", () => {
  const entry = {
    ProcessId: 2,
    ParentProcessId: 1,
    ExecutablePath: "C:\\package\\supervisor.exe",
    CommandLine: "supervisor.exe --thread-organization owner 1",
  };
  expect(
    organizerChildren(
      [
        entry,
        { ...entry, ProcessId: 3, ParentProcessId: 99 },
        { ...entry, ProcessId: 4, ExecutablePath: "C:\\other\\supervisor.exe" },
        { ...entry, ProcessId: 5, CommandLine: "supervisor.exe --system-monitor" },
      ],
      1,
      "c:\\PACKAGE\\supervisor.exe",
    ),
  ).toEqual([entry]);
});

describe("deadline evidence rejects early, duplicate and invalid transitions", () => {
  const snoozed = { state: "later", revision: 1, deadline: new Date(120_000).toISOString() };
  it("accepts persistence before deadline and one canonical expiry after it", () => {
    expect(() => assertDeadlineObservation(snoozed, snoozed, 119_999)).not.toThrow();
    expect(() =>
      assertDeadlineObservation({ ...snoozed, state: "needs-you", revision: 2 }, snoozed, 120_001),
    ).not.toThrow();
  });
  it("rejects an early move even if the final state would otherwise pass", () => {
    expect(() =>
      assertDeadlineObservation({ ...snoozed, state: "needs-you", revision: 2 }, snoozed, 119_999),
    ).toThrow("before its canonical deadline");
  });
  it("rejects duplicate commits and unexpected destination states", () => {
    expect(() =>
      assertDeadlineObservation({ ...snoozed, state: "needs-you", revision: 3 }, snoozed, 120_001),
    ).toThrow("exactly once");
    expect(() =>
      assertDeadlineObservation({ ...snoozed, state: "done" }, snoozed, 120_001),
    ).toThrow("Unexpected state");
  });
});

class FakeSocket extends EventTarget {
  sent: { id: string } | undefined;
  send(value: string) {
    this.sent = JSON.parse(value) as { id: string };
  }
  reply(exit: unknown, requestId = this.sent?.id) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify({ _tag: "Exit", requestId, exit }) }),
    );
  }
}

it("RPC ignores unrelated responses and rejects canonical server failures", async () => {
  const socket = new FakeSocket();
  const result = requestRpc(socket as unknown as WebSocket, "status");
  socket.reply({ _tag: "Success", value: "wrong" }, "unrelated");
  socket.reply({ _tag: "Success", value: "healthy" });
  await expect(result).resolves.toBe("healthy");
  const rejected = requestRpc(socket as unknown as WebSocket, "dispatch");
  socket.reply({ _tag: "Failure", cause: "rejected" });
  await expect(rejected).rejects.toThrow("rejected");
});

it("RPC has bounded timeout and immediate disconnect failure", async () => {
  vi.useFakeTimers();
  const socket = new FakeSocket();
  const timeout = expect(requestRpc(socket as unknown as WebSocket, "status")).rejects.toThrow(
    "RPC timeout",
  );
  await vi.advanceTimersByTimeAsync(5000);
  await timeout;
  const disconnected = expect(requestRpc(socket as unknown as WebSocket, "status")).rejects.toThrow(
    "Socket closed",
  );
  socket.dispatchEvent(new Event("close"));
  await disconnected;
  expect(vi.getTimerCount()).toBe(0);
});
