/**
 * M7 with the real binary (`BIGBUD_TERMINAL_HOST_IT=1`): a Direct SSH pane's ssh client runs in
 * the local terminal host, survives a backend restart, and is closed by Forget. No SSH server is
 * needed: a fake `ssh` on PATH runs the remote command locally, exactly as sshd would run it.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TerminalEvent } from "@bigbud/contracts";
import { Effect, Option, type Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fixture as journalFixture } from "../persistence/Layers/DirectShellLaunchOwners.test.helpers.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { TerminalViewRegistry } from "../terminal/activity/terminalViewRegistry.ts";
import { directShellOwnerKey } from "../terminal/Layers/DirectShellLaunch.owner.ts";
import { makeTerminalManagerWithOptions } from "../terminal/Layers/Manager.process.ts";
import type { TerminalManagerOptions } from "../terminal/Layers/Manager.types.ts";
import type { PtyAdapterShape } from "../terminal/Services/PTY.ts";
import { makeLocalTerminalHostPtyAdapter } from "./localTerminalHost.adapter.ts";
import {
  makeTerminalHostOwnerStore,
  realLocalTerminalHostController,
} from "./localTerminalHost.parity.testUtils.ts";
import { localTerminalHostPaths } from "./localTerminalHost.paths.ts";
import { makeLocalTerminalHostProcesses } from "./localTerminalHost.process.ts";
import { makeLocalTerminalHostRegistry } from "./localTerminalHost.registry.ts";
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
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
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

/** Runs the remote command (its last argument) locally, as sshd would on the target. */
async function installFakeSsh(dir: string) {
  await mkdir(dir, { recursive: true });
  const script = join(dir, "ssh");
  await writeFile(script, '#!/bin/sh\nfor last; do :; done\nexec /bin/sh -c "$last"\n');
  await chmod(script, 0o755);
  const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };
  process.env.PATH = `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  process.env.SHELL = "/bin/sh";
  cleanups.push(() => {
    process.env.PATH = saved.PATH;
    process.env.SHELL = saved.SHELL;
  });
}

describe.skipIf(!enabled)("M7 Direct SSH through the real local terminal host", () => {
  it("runs ssh in the host, survives a backend restart, and is closed by Forget", async () => {
    const root = await makeShortTerminalHostRoot();
    cleanups.push(root.cleanup);
    cleanups.push(async () => {
      for (const record of await makeLocalTerminalHostRegistry(root.paths).read()) {
        if (record.pid === undefined) continue;
        processes.signal(record.pid, "SIGTERM");
        await processes.waitForExit(record.pid, 3_000);
      }
    });
    await installFakeSsh(join(root.stateDir, "bin"));
    const cwd = join(root.stateDir, "remote-work");
    await mkdir(cwd);
    const ownerStore = await makeTerminalHostOwnerStore(root.stateDir);
    cleanups.push(ownerStore.dispose);
    const journal = await journalFixture();
    const options = (adapter: PtyAdapterShape): TerminalManagerOptions => ({
      logsDir: join(root.stateDir, "logs"),
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

    // Backend 1: the ssh client starts in the host; the backend stops without a quit hint.
    const sshPid = await run(
      Effect.gen(function* () {
        const manager = yield* makeTerminalManagerWithOptions(
          options(backend(root.stateDir, ownerStore.store).adapter),
        );
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
        expect(yield* Effect.promise(() => journal.store.getHosted!(recordKey))).toMatchObject({
          executionTargetId: target,
        });
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 600)));
        return opened.pid!;
      }),
    );
    expect(processes.isAlive(sshPid)).toBe(true);

    // Backend 2 (a restart): the pane reattaches to the same ssh session; Forget closes it.
    const second = backend(root.stateDir, ownerStore.store);
    await run(
      Effect.gen(function* () {
        const manager = yield* makeTerminalManagerWithOptions(options(second.adapter));
        const reopened = yield* manager.open({ ...pane, attachOnly: true });
        expect(reopened.pid).toBe(sshPid);
        expect(yield* manager.forgetRetainedShellOwners!({ threadId: pane.threadId })).toEqual({
          forgotten: 1,
        });
        yield* Effect.promise(() =>
          until(() => !processes.isAlive(sshPid), "the ssh session to end after Forget", 5_000),
        );
        expect(yield* Effect.promise(() => journal.store.getHosted!(recordKey))).toBeUndefined();
        yield* manager.close({ threadId: pane.threadId, deleteHistory: true });
      }),
    );
    const inventory = await second.runtime.hostGenerations!.inventory();
    expect(inventory.filter((entry) => entry.state === "running")).toEqual([]);
  }, 60_000);
});
