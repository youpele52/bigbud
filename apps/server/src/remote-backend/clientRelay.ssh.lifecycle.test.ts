import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { join } from "node:path";
const state = vi.hoisted(() => ({
  args: [] as string[],
  children: [] as import("node:child_process").ChildProcess[],
  fake: undefined as import("node:child_process").ChildProcess | undefined,
}));
vi.mock("../ssh/sshVerification.ts", () => ({
  assertSshExecutionTargetReadyAsync: async () => {},
}));
vi.mock("../ssh/sshHostTrust.ts", () => ({ inspectSshHostTrust: async () => {} }));
vi.mock("../ssh/sshCommand.ts", () => ({
  buildSshCommandInvocation: () => ({ command: process.execPath, args: state.args }),
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
import { makeClientRelaySshChannels } from "./clientRelay.ssh.ts";
import { ownClientRelaySshChild } from "./clientRelay.ssh.child.ts";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  state.fake = undefined;
  state.children = [];
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const deployment = {
  nodeBinary: process.execPath,
  nodeSha256: "a".repeat(64),
  helperEntry: "/fixture/helper.mjs",
  helperSha256: "b".repeat(64),
  authorityId: "c".repeat(32),
};
it("confirmed child exit preserves unread final response bytes until stdout EOF", async () => {
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
  const owner = ownClientRelaySshChild(child, new AbortController().signal);
  child.stdout.write("final response");
  child.emit("exit", 0, null);
  await owner.waitForExit(100);
  expect(owner.stream.destroyed).toBe(false);
  expect(child.stderr.destroyed).toBe(true);
  child.stdout.end();
  const chunks: Buffer[] = [];
  for await (const chunk of owner.stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe("final response");
  expect(child.kill).not.toHaveBeenCalled();
});
it("known SSH exit is not held hostage by inherited stderr in a real descendant", async () => {
  const root = await fs.mkdtemp("/tmp/bb-ssh-fd-");
  const completed = join(root, "descendant-finished");
  const script = join(root, "parent.cjs");
  const descendant = `setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(completed)},'done')},800)`;
  await fs.writeFile(
    script,
    `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore',2],env:{PATH:'/usr/bin:/bin'}});child.unref();process.exit(0);`,
  );
  state.args = [script];
  // The controlled descendant exits by itself; this test never kills a global/process group PID.
  cleanup.push(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await fs.rm(root, { recursive: true, force: true });
  });
  const owner = makeClientRelaySshChannels({ executionTargetId: "ssh:fixture", deployment });
  cleanup.push(() => owner.dispose());
  await owner.openChannel(new AbortController().signal);
  const child = state.children[0]!;
  await once(child, "exit");
  await owner.dispose();
  expect(child.exitCode).toBe(0);
  expect(
    await fs.access(completed).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});
it("an unconfirmed owned child returns bounded cleanup failure instead of success", async () => {
  const fake = Object.assign(new ChildProcess(), {
    pid: 43210,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  state.fake = fake;
  const owner = makeClientRelaySshChannels({ executionTargetId: "ssh:fixture", deployment });
  cleanup.push(() => {
    fake.emit("exit", 0, null);
    fake.emit("close", 0, null);
    fake.stdin.destroy();
    fake.stdout.destroy();
    fake.stderr.destroy();
  });
  await owner.openChannel(new AbortController().signal);
  await expect(
    Promise.race([
      owner.dispose(),
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("test cleanup deadline exceeded")), 3500);
        timeout.unref();
      }),
    ]),
  ).rejects.toThrow("confirm owned child exit");
  expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
  expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
  await expect(owner.dispose()).rejects.toThrow("confirm owned child exit");
});
