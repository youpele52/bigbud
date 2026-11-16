import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { MobileGatewaySupervisor } from "./mobileGatewaySupervisor.ts";
import {
  mobileGatewayCommand,
  type MobileGatewayLaunch,
} from "./mobileGatewaySupervisor.config.ts";

const config: MobileGatewayLaunch = {
  binary: "/fixture/gateway",
  port: 4000,
  upstream: { kind: "unix", path: "/private/remote-mobile.sock" },
  externalOrigin: "https://host.example",
  credential: "private-gateway-credential-1234567890",
};
function fakeGatewayChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("uses the fixed Unix upstream with a lifeline and only its transport credential", () => {
  for (const key of [
    "BIGBUD_AUTH_TOKEN",
    "T3CODE_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "BIGBUD_REMOTE_SERVICE_CONFIG",
  ])
    vi.stubEnv(key, "must-not-reach-transport");
  const command = mobileGatewayCommand(config);
  expect(command.args).toContain("--stdin-lifeline");
  expect(command.args).toContain("--upstream-unix");
  expect(command.args).toContain("/private/remote-mobile.sock");
  expect(command.args).not.toContain("--upstream");
  expect(JSON.stringify(command.args)).not.toContain(config.credential);
  expect(command.env.BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL).toBe(config.credential);
  expect(JSON.stringify(command.env)).not.toContain("must-not-reach-transport");
});

it.each([
  { upstream: { kind: "unix", path: "relative.sock" } },
  { upstream: { kind: "unix", path: "/a/../b.sock" } },
  { upstream: { kind: "unix", path: "/" + "x".repeat(108) } },
  { upstream: { kind: "loopback", port: 4000 } },
  { upstream: { kind: "loopback", port: 65536 } },
  { credential: "short" },
  { credential: "x".repeat(32) + "\n" },
  { externalOrigin: "https://host.example/path" },
  { externalOrigin: "https://credential@host.example" },
  { externalOrigin: "http://host.example" },
  { assetsDir: "relative-assets" },
] satisfies Partial<MobileGatewayLaunch>[])("refuses unsafe fixed configuration %j", (patch) => {
  expect(() => mobileGatewayCommand({ ...config, ...patch })).toThrow();
});

it("captures the launch before caller mutation and never starts after owner consent is lost", async () => {
  vi.useFakeTimers();
  const child = fakeGatewayChild();
  const spawn = vi.fn(() => child);
  const mutable = {
    ...config,
    upstream: { kind: "unix" as const, path: "/private/original.sock" },
  };
  let allowed = true;
  const owner = new MobileGatewaySupervisor(mutable, {
    spawn: spawn as never,
    allowed: () => allowed,
  });
  mutable.binary = "/replacement/gateway";
  mutable.upstream.path = "/replacement/upstream.sock";
  const started = owner.start();
  child.stdout.write('{"event":"ready","listen":"127.0.0.1:4000"}\n');
  await started;
  expect(spawn).toHaveBeenCalledWith(
    "/fixture/gateway",
    expect.arrayContaining(["/private/original.sock"]),
    expect.any(Object),
  );
  allowed = false;
  child.emit("close", 1);
  await vi.advanceTimersByTimeAsync(500);
  expect(spawn).toHaveBeenCalledTimes(1);
  await owner.stop();
});

it("retains a per-call consent guard for automatic restarts", async () => {
  vi.useFakeTimers();
  const children: Array<ReturnType<typeof fakeGatewayChild>> = [];
  const spawn = vi.fn(() => {
    const next = fakeGatewayChild();
    children.push(next);
    return next;
  });
  let allowed = true;
  const owner = new MobileGatewaySupervisor(config, { spawn: spawn as never });
  try {
    const start = owner.start(() => allowed);
    children[0]!.stdout.write('{"event":"ready","listen":"127.0.0.1:4000"}\n');
    await start;
    allowed = false;
    children[0]!.emit("close", 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally {
    const stopped = owner.stop();
    children.at(-1)!.emit("close", 0);
    await stopped;
  }
});

it("leaves an exited child's next launch to its durable owner", async () => {
  vi.useFakeTimers();
  const children: Array<ReturnType<typeof fakeGatewayChild>> = [];
  const spawn = vi.fn(() => {
    const next = fakeGatewayChild();
    children.push(next);
    return next;
  });
  const owner = new MobileGatewaySupervisor(config, {
    spawn: spawn as never,
    autoRestart: false,
  });
  try {
    const started = owner.start();
    children[0]!.stdout.write('{"event":"ready","listen":"127.0.0.1:4000"}\n');
    await started;
    children[0]!.emit("close", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(owner.getStatus()).toBe("needs-repair");
  } finally {
    const stopped = owner.stop();
    children.at(-1)!.emit("close", 0);
    await stopped;
  }
});

it("does not spend another launch after its durable owner's spawn attempt fails", async () => {
  vi.useFakeTimers();
  const spawn = vi.fn(() => {
    throw new Error("fixture spawn failure");
  });
  const owner = new MobileGatewaySupervisor(config, {
    spawn: spawn as never,
    autoRestart: false,
  });
  await expect(owner.start()).rejects.toThrow("Mobile gateway could not start.");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(owner.getStatus()).toBe("needs-repair");
  await owner.stop();
});
