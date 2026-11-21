/**
 * S3 smoke test with the real binary (`BIGBUD_TERMINAL_HOST_IT=1`): the terminal manager opens a
 * host terminal, a backend stop without a quit hint detaches it, a new backend reattaches it and
 * sends its screen first, and a quit with the default setting closes it in the host. The idle
 * warning and close run against the real host in `localTerminalHost.e2e.lifecycle.it.test.ts`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TerminalEvent } from "@bigbud/contracts";
import type { TerminalScreenItem } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { Effect, Option, type Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { TerminalViewRegistry } from "../terminal/activity/terminalViewRegistry.ts";
import { makeTerminalManagerWithOptions } from "../terminal/Layers/Manager.process.ts";
import type { TerminalManagerOptions } from "../terminal/Layers/Manager.types.ts";
import type { PtyAdapterShape } from "../terminal/Services/PTY.ts";
import { reachableHostInventoryEntries } from "../terminal/Services/OwnedPtyRuntime.ts";
import { makeLocalTerminalHostPtyAdapter } from "./localTerminalHost.adapter.ts";
import {
  makeTerminalHostOwnerStore,
  realLocalTerminalHostController,
} from "./localTerminalHost.parity.testUtils.ts";
import { localTerminalHostPaths } from "./localTerminalHost.paths.ts";
import { makeLocalTerminalHostProcesses } from "./localTerminalHost.process.ts";
import { makeLocalTerminalHostRegistry } from "./localTerminalHost.registry.ts";
import { makeShortTerminalHostRoot } from "./localTerminalHost.testUtils.ts";

const enabled = process.env.BIGBUD_TERMINAL_HOST_IT === "1" && process.platform !== "win32";
const processes = makeLocalTerminalHostProcesses();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const noFallback: PtyAdapterShape = {
  spawn: () => Effect.die(new Error("The smoke terminal must run in the host.")),
};

async function ownerStore(stateDir: string) {
  const owners = await makeTerminalHostOwnerStore(stateDir);
  cleanups.push(owners.dispose);
  return owners.store;
}

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

describe.skipIf(!enabled)("S3 manager integration with the real binary", () => {
  it("opens, detaches, reattaches with a screen after a restart, and closes on quit", async () => {
    const root = await makeShortTerminalHostRoot();
    cleanups.push(root.cleanup);
    cleanups.push(async () => {
      for (const record of await makeLocalTerminalHostRegistry(root.paths).read()) {
        if (record.pid === undefined) continue;
        processes.signal(record.pid, "SIGTERM");
        await processes.waitForExit(record.pid, 3_000);
      }
    });
    const cwd = join(root.stateDir, "work");
    await mkdir(cwd);
    const owners = await ownerStore(root.stateDir);
    const options = (adapter: PtyAdapterShape, extra: Partial<TerminalManagerOptions>) => ({
      logsDir: join(root.stateDir, "logs"),
      ptyAdapter: adapter,
      agentDetector: () => Effect.succeed(new Map()),
      subprocessPollIntervalMs: 60_000,
      shellResolver: () => "/bin/sh",
      views: new TerminalViewRegistry(),
      ...extra,
    });
    const pane = { threadId: "thread-1", terminalId: "default", cwd, cols: 100, rows: 30 };

    // Backend 1: open a host terminal, print a marker, then stop without a quit hint.
    const shellPid = await run(
      Effect.gen(function* () {
        const manager = yield* makeTerminalManagerWithOptions(
          options(backend(root.stateDir, owners).adapter, {
            resolveQuitIntent: Effect.succeed(Option.none()),
          }),
        );
        let text = "";
        yield* manager.subscribe((event: TerminalEvent) =>
          Effect.sync(() => {
            if (event.type === "output") text += event.data;
          }),
        );
        const opened = yield* manager.open(pane);
        expect(opened).toMatchObject({ status: "running", screenSource: "host", restorable: true });
        yield* manager.write({ ...pane, data: "echo smoke-$((40+2))\r" });
        yield* Effect.promise(() => until(() => text.includes("smoke-42"), "marker output"));
        // Let the debounced history write land, so the next backend knows to reattach.
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 600)));
        return opened.pid!;
      }),
    );
    expect(processes.isAlive(shellPid)).toBe(true);

    // Backend 2 (a restart): the view subscribes first, then reopens the restored pane.
    const second = backend(root.stateDir, owners);
    await run(
      Effect.gen(function* () {
        const manager = yield* makeTerminalManagerWithOptions(
          options(second.adapter, {
            resolveQuitIntent: Effect.succeed(
              Option.some({ sequence: 1, reason: "quit" as const, occurredAt: Date.now() }),
            ),
            keepRunningAfterQuit: () => false,
          }),
        );
        const screens: TerminalScreenItem[] = [];
        const view = yield* manager.subscribeSession!(
          { threadId: pane.threadId, terminalId: pane.terminalId, acceptScreen: true },
          {
            screen: (item) => screens.push(item),
            event: () => undefined,
            overflow: () => undefined,
          },
        );
        view.start();
        const reopened = yield* manager.open({ ...pane, attachOnly: true });
        expect(reopened.pid).toBe(shellPid);
        yield* Effect.promise(() => until(() => screens.length > 0, "the screen item"));
        expect(screens[0]!.ansi).toContain("smoke-42");
        view.unsubscribe(0);
      }),
    );

    // Quit with the default setting closed the managed terminal through the host: the host
    // hangs up and escalates, so the shell itself is gone (allow its close grace plus the reap).
    await until(() => !processes.isAlive(shellPid), "the shell to exit after quit", 3_500);
    // The notice cursor survives adoption, so the next launch summarizes only unseen closes.
    const records = await makeLocalTerminalHostRegistry(root.paths).read();
    expect(records[0]?.noticeCursor?.epoch).toEqual(expect.any(String));
    const inventory = reachableHostInventoryEntries(
      await second.runtime.hostGenerations!.inventory(),
    );
    expect(inventory.filter((candidate) => candidate.state === "running")).toEqual([]);
  }, 60_000);
});
