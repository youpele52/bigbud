import { afterEach, expect, it, vi } from "vitest";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { once } from "node:events";
const state = vi.hoisted(() => ({
  children: [] as import("node:child_process").ChildProcess[],
  fake: undefined as import("node:child_process").ChildProcess | undefined,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (state.fake) return state.fake;
      const child = actual.spawn(...args);
      state.children.push(child);
      return child;
    },
  };
});
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
const connections: RemoteAgentConnection[] = [];
afterEach(async () => {
  if (state.fake) state.fake.emit("exit", 0, null);
  for (const child of state.children)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(connections.splice(0).map((connection) => connection.closeConfirmed(1000)));
  state.children = [];
  state.fake = undefined;
});
function local(script: string) {
  const connection = RemoteAgentConnection.local({
    binaryPath: process.execPath,
    args: ["-e", script],
    env: { PATH: "/usr/bin:/bin" },
  });
  connections.push(connection);
  return connection;
}
it("awaits exact original exit even after the health path already called plain close", async () => {
  const connection = local(
    "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),120));setInterval(()=>{},1000);process.stderr.write('READY');",
  );
  const child = state.children.at(-1)!;
  await once(child.stderr!, "data");
  const before = performance.now();
  connection.close();
  expect(child.exitCode).toBeNull();
  await connection.closeConfirmed();
  expect(performance.now() - before).toBeGreaterThanOrEqual(80);
  expect(child.exitCode).toBe(0);
});
it("does not let an inherited stderr pipe delay known owned-child reap", async () => {
  const connection = local(
    "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},500)'],{stdio:['ignore','ignore',2],env:{PATH:'/usr/bin:/bin'}}).unref();process.exit(0);",
  );
  const child = state.children.at(-1)!;
  await once(child, "exit");
  await connection.closeConfirmed();
  expect(child.stderr?.destroyed).toBe(true);
  expect(child.exitCode).toBe(0);
});
it("returns bounded repair failure when the original child never confirms exit", async () => {
  const stdio: [PassThrough, PassThrough, PassThrough, undefined, undefined] = [
    new PassThrough(),
    new PassThrough(),
    new PassThrough(),
    undefined,
    undefined,
  ];
  const child = Object.assign(new ChildProcess(), {
    pid: 43210,
    stdio,
    stdin: stdio[0],
    stdout: stdio[1],
    stderr: stdio[2],
    kill: vi.fn(() => true),
  });
  state.fake = child;
  const connection = local("unused");
  connection.close();
  const before = performance.now();
  await expect(connection.closeConfirmed(100)).rejects.toThrow("confirm original child exit");
  expect(performance.now() - before).toBeLessThan(1000);
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});
