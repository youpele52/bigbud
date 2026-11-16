import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileGatewaySupervisor } from "./mobileGatewaySupervisor";
import { MOBILE_GATEWAY_POLICY } from "../constants/mobileGateway";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
function fixture() {
  const children: ReturnType<typeof makeChild>[] = [];
  const spawn = vi.fn(() => {
    const child = makeChild();
    children.push(child);
    return child;
  });
  const supervisor = new MobileGatewaySupervisor(
    {
      binary: "/fixture/gateway",
      port: 4000,
      backendPort: 3773,
      externalOrigin: "https://desktop.example",
      credential: "secret".repeat(8),
    },
    { spawn: spawn as never },
  );
  return { supervisor, spawn, children };
}
function makeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  child.kill.mockImplementation(() => {
    child.emit("close", 1);
    return true;
  });
  return child;
}
function ready(child: ReturnType<typeof makeChild>) {
  child.stdout.write('{"event":"ready","listen":"127.0.0.1:4000"}\n');
}
it("requires matching readiness and puts the credential only in the environment", async () => {
  const f = fixture();
  const start = f.supervisor.start();
  expect(f.supervisor.getStatus()).toBe("starting");
  ready(f.children[0]!);
  await start;
  expect(f.supervisor.getStatus()).toBe("ready");
  const call = f.spawn.mock.calls[0] as unknown as [
    string,
    string[],
    { env: Record<string, string> },
  ];
  expect(call[1]).toContain("--stdin-lifeline");
  expect(JSON.stringify(call[1])).not.toContain("secret");
  expect(call[2].env.BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL).toBe("secret".repeat(8));
});
it("limits rapid crashes to five restarts even when each launch becomes ready", async () => {
  const f = fixture();
  const first = f.supervisor.start();
  ready(f.children[0]!);
  await first;
  for (let i = 0; i < 6; i++) {
    f.children.at(-1)!.emit("close", 1);
    if (i < 5) await vi.advanceTimersByTimeAsync(500 * 2 ** i);
    if (i < 5) ready(f.children.at(-1)!);
  }
  expect(f.spawn).toHaveBeenCalledTimes(6);
  expect(f.supervisor.getStatus()).toBe("needs-repair");
  await expect(f.supervisor.start()).rejects.toThrow("needs repair");
});
it("bounds missing/oversized readiness and cancels retries on stop", async () => {
  const f = fixture();
  const first = f.supervisor.start();
  const rejected = expect(first).rejects.toThrow();
  f.children[0]!.stdout.write("x".repeat(MOBILE_GATEWAY_POLICY.maxReadyBytes + 1));
  await rejected;
  await f.supervisor.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.supervisor.getStatus()).toBe("stopped");
});
it("readiness timeout kills the old child before a retry; stale events cannot mark ready", async () => {
  const f = fixture();
  const start = f.supervisor.start();
  const rejected = expect(start).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  expect(f.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  await vi.advanceTimersByTimeAsync(500);
  ready(f.children[0]!);
  expect(f.supervisor.getStatus()).toBe("starting");
  ready(f.children[1]!);
  expect(f.supervisor.getStatus()).toBe("ready");
});
it("closes the lifeline and waits for child exit; no restart after explicit stop", async () => {
  const f = fixture();
  const start = f.supervisor.start();
  ready(f.children[0]!);
  await start;
  const stopped = f.supervisor.stop();
  expect(f.children[0]!.stdin.writableEnded).toBe(true);
  f.children[0]!.emit("close", 0);
  await stopped;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.spawn).toHaveBeenCalledTimes(1);
});

it("refuses another child while shutdown is unconfirmed", async () => {
  const f = fixture();
  const start = f.supervisor.start();
  ready(f.children[0]!);
  await start;
  f.children[0]!.kill.mockImplementation(() => true);
  const stop = f.supervisor.stop();
  const rejected = expect(stop).rejects.toThrow("not confirmed");
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  await expect(f.supervisor.start()).rejects.toThrow("not confirmed");
  expect(f.spawn).toHaveBeenCalledTimes(1);
});
it("readiness mismatch cannot advertise or leave an unbounded startup", async () => {
  const f = fixture();
  const start = f.supervisor.start();
  const rejected = expect(start).rejects.toThrow();
  f.children[0]!.stdout.write('{"event":"ready","listen":"0.0.0.0:4000"}\n');
  await rejected;
  expect(f.supervisor.getStatus()).toBe("retrying");
  await f.supervisor.stop();
});
