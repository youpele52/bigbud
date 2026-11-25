/**
 * S0 F04/X2: exercise legacy Direct SSH through the real local native host, with a recording
 * `ssh` executable and isolated state. This is a baseline, not release-profile qualification.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TerminalEvent } from "@bigbud/contracts";
import { Effect, Option, type Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fixture as journalFixture } from "../persistence/Layers/DirectShellLaunchOwners.test.helpers.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { TerminalViewRegistry } from "../terminal/activity/terminalViewRegistry.ts";
import { directShellOwnerKey } from "../terminal/Layers/DirectShellLaunch.owner.ts";
import { historyPath } from "../terminal/Layers/Manager.history-io.ts";
import { makeTerminalManagerWithOptions } from "../terminal/Layers/Manager.process.ts";
import type { TerminalManagerOptions } from "../terminal/Layers/Manager.types.ts";
import { ownedTerminalOwnerRouteKey } from "../terminal/Layers/OwnedPtyRuntime.owner.ts";
import type { PtyAdapterShape } from "../terminal/Services/PTY.ts";
import { reachableHostInventoryEntries } from "../terminal/Services/OwnedPtyRuntime.ts";
import { makeLocalTerminalHostPtyAdapter } from "./localTerminalHost.adapter.ts";
import {
  makeTerminalHostOwnerStore,
  realLocalTerminalHostController,
} from "./localTerminalHost.parity.testUtils.ts";
import { localTerminalHostPaths } from "./localTerminalHost.paths.ts";
import { makeLocalTerminalHostProcesses, runProcessCommand } from "./localTerminalHost.process.ts";
import {
  makeLocalTerminalHostRegistry,
  type LocalTerminalHostRecord,
} from "./localTerminalHost.registry.ts";
import { makeShortTerminalHostRoot } from "./localTerminalHost.testUtils.ts";

vi.mock("../ssh/sshProcess", () => ({
  runSshCommand: vi.fn(async (input: { args: string[] }) => ({
    stdout: `\x1e${input.args[3]}\x1f`,
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  })),
}));

const enabled = process.env.BIGBUD_TERMINAL_HOST_IT === "1" && process.platform !== "win32";
const target = "ssh:host=devbox.test&user=me&auth=ssh-key&transport=direct-ssh";
const processes = makeLocalTerminalHostProcesses();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

const noFallback: PtyAdapterShape = {
  spawn: () => Effect.die(new Error("The Direct SSH terminal must run in the host.")),
};

function backend(stateDir: string, owners: RemoteAgentOwnerStore) {
  const controller = realLocalTerminalHostController(localTerminalHostPaths(stateDir), processes);
  const local = makeLocalTerminalHostPtyAdapter({
    controller,
    owners,
    fallback: noFallback,
    stateDir,
  });
  cleanups.push(() => local.close());
  return local;
}

const until = async (check: () => boolean, label: string, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer)));

/** Records only process ancestry and argv shape, then executes the synthetic remote command locally. */
async function installSshRecorder(home: string) {
  const dir = join(home, "bin");
  const log = join(home, "ssh-launches");
  await mkdir(dir);
  await symlink("/bin/sh", join(dir, "sh"));
  await writeFile(
    join(dir, "ssh"),
    `#!/bin/sh
printf '%s %s %s %s\\n' "$$" "$PPID" "$#" "$1" >> "$HOME/ssh-launches"
for last; do :; done
exec /bin/sh -c "$last"
`,
    { mode: 0o700 },
  );
  // The PTY launch can find only our recorder, never a real OpenSSH executable.
  vi.stubEnv("PATH", dir);
  vi.stubEnv("HOME", home);
  vi.stubEnv("SHELL", "/bin/sh");
  return () => readFile(log, "utf8");
}

async function isFixtureHost(record: LocalTerminalHostRecord) {
  if ((await processes.verify(record.pid, record.pidStartTime)) !== "verified") return false;
  const command = await runProcessCommand("/bin/ps", [
    "-ww",
    "-o",
    "command=",
    "-p",
    String(record.pid),
  ]);
  return (
    command.code === 0 && command.stdout.trim().startsWith(`${record.binaryPath} --supervisor `)
  );
}

async function retireFixtureHost(record: LocalTerminalHostRecord) {
  if (record.pid === undefined || !(await isFixtureHost(record))) return false;
  return processes.signal(record.pid, "SIGTERM") && processes.waitForExit(record.pid, 5_000);
}

describe.skipIf(!enabled)("S0 F04/X2 Direct SSH through the real local terminal host", () => {
  it("records native launcher ancestry, reuses the owner, and retires the drained fixture host", async () => {
    const root = await makeShortTerminalHostRoot();
    const registry = makeLocalTerminalHostRegistry(root.paths);
    cleanups.push(root.cleanup);
    cleanups.push(async () => {
      for (const record of await registry.read()) await retireFixtureHost(record);
    });
    const launches = await installSshRecorder(root.stateDir);
    const cwd = join(root.stateDir, "remote-work");
    await mkdir(cwd);
    const ownerStore = await makeTerminalHostOwnerStore(root.stateDir);
    cleanups.push(ownerStore.dispose);
    const journal = await journalFixture();
    const logsDir = join(root.stateDir, "logs");
    const options = (adapter: PtyAdapterShape): TerminalManagerOptions => ({
      logsDir,
      ptyAdapter: adapter,
      agentDetector: () => Effect.succeed(new Map()),
      subprocessPollIntervalMs: 60_000,
      views: new TerminalViewRegistry(),
      directShellOwners: journal.store,
      resolveQuitIntent: Effect.succeed(Option.none()),
    });
    const pane = {
      threadId: "thread-1",
      terminalId: "ssh",
      executionTargetId: target,
      cwd,
      cols: 100,
      rows: 30,
    };
    const recordKey = directShellOwnerKey(pane.threadId, pane.terminalId);
    const hostOwnerKey = ownedTerminalOwnerRouteKey(pane.threadId, pane.terminalId);

    // Backend scope 1: start the SSH client and stop the backend without a quit hint.
    const first = backend(root.stateDir, ownerStore.store);
    const { sshPid, hosted, hostOwner } = await run(
      Effect.gen(function* () {
        const manager = yield* makeTerminalManagerWithOptions(options(first.adapter));
        let text = "";
        yield* manager.subscribe((event: TerminalEvent) =>
          Effect.sync(() => {
            if (event.type === "output") text += event.data;
          }),
        );
        const opened = yield* manager.open(pane);
        expect(opened).toMatchObject({ status: "running", screenSource: "host" });
        yield* manager.write({ ...pane, data: "echo direct-$((40+2))\r" });
        yield* Effect.promise(() => until(() => text.includes("direct-42"), "remote output"));
        // The generation-scoped PID marker is consumed, never shown.
        expect(text).not.toContain("bigbud-shell-");
        // Attach-only recovery requires retained history. Wait for the debounced write, not a sleep.
        yield* Effect.promise(() =>
          vi.waitFor(async () => {
            expect(
              await readFile(historyPath(logsDir, pane.threadId, pane.terminalId), "utf8"),
            ).toContain("direct-42");
          }, 5_000),
        );
        const hosted = yield* Effect.promise(() => journal.store.getHosted!(recordKey));
        expect(hosted).toMatchObject({ executionTargetId: target });
        const hostOwner = yield* Effect.promise(() => ownerStore.store.get(hostOwnerKey));
        expect(hostOwner).toMatchObject({
          epoch: expect.any(String),
          connectionId: expect.any(String),
          resourceId: expect.any(String),
          state: "may-have-been-sent",
        });
        expect(opened.pid).toEqual(expect.any(Number));
        return { sshPid: opened.pid!, hosted: hosted!, hostOwner: hostOwner! };
      }),
    );
    await first.close();
    const [host] = await registry.read();
    expect(host).toMatchObject({ pid: expect.any(Number), epoch: hostOwner.epoch });
    expect(await isFixtureHost(host!)).toBe(true);
    const launch = `${sshPid} ${host!.pid} 6 -tt\n`;
    expect(await launches()).toBe(launch);
    expect(processes.isAlive(sshPid)).toBe(true);

    // Backend scope 2: reattach, then explicitly authorize the drain with Forget.
    const second = backend(root.stateDir, ownerStore.store);
    await run(
      Effect.gen(function* () {
        const manager = yield* makeTerminalManagerWithOptions(options(second.adapter));
        const reopened = yield* manager.open({ ...pane, attachOnly: true });
        expect(reopened.pid).toBe(sshPid);
        expect(yield* Effect.promise(() => journal.store.getHosted!(recordKey))).toMatchObject({
          reservationId: hosted.reservationId,
        });
        expect(yield* Effect.promise(() => ownerStore.store.get(hostOwnerKey))).toMatchObject({
          epoch: hostOwner.epoch,
          connectionId: hostOwner.connectionId,
          resourceId: hostOwner.resourceId,
        });
        expect(yield* Effect.promise(launches)).toBe(launch);
        expect(yield* manager.forgetRetainedShellOwners!({ threadId: pane.threadId })).toEqual({
          forgotten: 1,
        });
        yield* Effect.promise(() =>
          until(() => !processes.isAlive(sshPid), "the ssh session to end after Forget", 5_000),
        );
        expect(yield* Effect.promise(() => journal.store.getHosted!(recordKey))).toBeUndefined();
        yield* Effect.promise(() =>
          vi.waitFor(async () => {
            expect(await ownerStore.store.get(hostOwnerKey)).toMatchObject({ state: "terminal" });
          }, 5_000),
        );
        yield* manager.close({ threadId: pane.threadId, deleteHistory: true });
        const closed = yield* Effect.flip(manager.open({ ...pane, attachOnly: true }));
        expect(closed._tag).toBe("TerminalNotRunningError");
      }),
    );
    const inventory = reachableHostInventoryEntries(
      await second.runtime.hostGenerations!.inventory(),
    );
    expect(inventory.filter((entry) => entry.state === "running")).toEqual([]);
    await second.close();
    // One-shot offline retirement of the verified temp host, not a production admission fence.
    expect(await retireFixtureHost(host!)).toBe(true);
    expect(await launches()).toBe(launch);
  }, 60_000);
});
