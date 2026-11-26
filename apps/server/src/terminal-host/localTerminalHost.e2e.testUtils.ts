/**
 * Real-binary wiring for the Q1 end-to-end tests and the soak harness: a short state root, the
 * durable owner store, one backend (terminal manager over the real local terminal host) per
 * "process lifetime", and helpers to watch output, screens and lifecycle notices. Nothing here
 * imports vitest, so `scripts/terminal-host-soak.ts` reuses it.
 *
 * @module localTerminalHost.e2e.testUtils
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TerminalEvent } from "@bigbud/contracts";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import type { TerminalScreenItem } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { Effect, Option, type Scope } from "effect";

import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { TerminalViewRegistry } from "../terminal/activity/terminalViewRegistry.ts";
import { makeTerminalManagerWithOptions } from "../terminal/Layers/Manager.process.ts";
import type { TerminalManagerOptions } from "../terminal/Layers/Manager.types.ts";
import type { TerminalManagerShape } from "../terminal/Services/Manager.ts";
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

export const hostE2eEnabled =
  process.env.BIGBUD_TERMINAL_HOST_IT === "1" && process.platform !== "win32";

export const hostProcesses = makeLocalTerminalHostProcesses();

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(25);
  }
}

export const runScoped = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>,
) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer)));

export const runEffect = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

const noFallback: PtyAdapterShape = {
  spawn: () => Effect.die(new Error("The end-to-end terminal must run in the host.")),
};

/** A quit decision as the desktop sends it; `none` is a backend stop without a hint. */
export const quitIntent = (kind: "none" | "quit") =>
  Effect.succeed(
    kind === "none"
      ? Option.none()
      : Option.some({ sequence: 1, reason: "quit" as const, occurredAt: Date.now() }),
  );

export interface HostE2eWorld {
  readonly stateDir: string;
  readonly cwd: string;
  readonly owners: RemoteAgentOwnerStore;
  readonly cleanup: () => Promise<void>;
  /** Live host PIDs from the registry (every generation). */
  readonly hostPids: () => Promise<number[]>;
  /**
   * A new backend (manager over the real host); `close` ends it like a backend exit. With
   * `record: false` output and events are not kept (long soaks), only `onEvent` sees them.
   */
  readonly backend: (
    extra?: Partial<TerminalManagerOptions>,
    capture?: { readonly record?: boolean; readonly onEvent?: (event: TerminalEvent) => void },
  ) => Promise<HostE2eBackend>;
}

export interface HostE2eBackend {
  readonly manager: TerminalManagerShape;
  readonly adapter: ReturnType<typeof makeLocalTerminalHostPtyAdapter>;
  readonly views: TerminalViewRegistry;
  /** Every output event's text per `threadId/terminalId`. */
  readonly output: Map<string, string>;
  readonly notices: TerminalLifecycleNotice[];
  readonly events: TerminalEvent[];
  /** Runs the manager's shutdown (quit policy first) and the host client's close. */
  readonly close: () => Promise<void>;
}

export const paneKey = (threadId: string, terminalId: string) => `${threadId}/${terminalId}`;

export async function makeHostE2eWorld(): Promise<HostE2eWorld> {
  const root = await makeShortTerminalHostRoot();
  const cwd = join(root.stateDir, "work");
  await mkdir(cwd);
  const owners = await makeTerminalHostOwnerStore(root.stateDir);
  const disposers: Array<() => Promise<void> | void> = [];
  const hostPids = async () =>
    (await makeLocalTerminalHostRegistry(root.paths).read())
      .map((record) => record.pid)
      .filter((pid): pid is number => pid !== undefined && hostProcesses.isAlive(pid));
  const cleanup = async () => {
    for (const dispose of disposers.splice(0).toReversed()) await dispose();
    for (const pid of await hostPids().catch(() => [])) {
      hostProcesses.signal(pid, "SIGTERM");
      await hostProcesses.waitForExit(pid, 3_000);
    }
    await owners.dispose();
    await root.cleanup();
  };
  const backend: HostE2eWorld["backend"] = async (extra = {}, capture = {}) => {
    const record = capture.record !== false;
    const controller = realLocalTerminalHostController(
      localTerminalHostPaths(root.stateDir),
      hostProcesses,
    );
    const adapter = makeLocalTerminalHostPtyAdapter({
      controller,
      owners: owners.store,
      fallback: noFallback,
      stateDir: root.stateDir,
    });
    const views = extra.views ?? new TerminalViewRegistry();
    const output = new Map<string, string>();
    const notices: TerminalLifecycleNotice[] = [];
    const events: TerminalEvent[] = [];
    let release: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => (release = resolve));
    let manager: TerminalManagerShape | undefined;
    let scopeDone: Promise<void> = Promise.resolve();
    const ready = new Promise<void>((resolve, reject) => {
      scopeDone = runScoped(
        Effect.gen(function* () {
          manager = yield* makeTerminalManagerWithOptions({
            logsDir: join(root.stateDir, "logs"),
            ptyAdapter: adapter.adapter,
            agentDetector: () => Effect.succeed(new Map()),
            subprocessPollIntervalMs: 60_000,
            shellResolver: () => "/bin/sh",
            resolveQuitIntent: quitIntent("none"),
            ...extra,
            views,
          });
          yield* manager.subscribe((event) =>
            Effect.sync(() => {
              capture.onEvent?.(event);
              if (!record) return;
              events.push(event);
              if (event.type !== "output") return;
              const key = paneKey(event.threadId, event.terminalId);
              output.set(key, (output.get(key) ?? "") + event.data);
            }),
          );
          yield* manager.subscribeLifecycle!((notice) => Effect.sync(() => notices.push(notice)));
          resolve();
          // Hold the scope (and with it the manager) until close.
          yield* Effect.promise(() => closed);
        }),
      );
      scopeDone.catch(reject);
    });
    await ready;
    let done = false;
    const close = async () => {
      if (done) return;
      done = true;
      release?.();
      // The scope's end runs the manager's shutdown: the quit policy, then the detach.
      await scopeDone.catch(() => undefined);
      await adapter.close();
    };
    disposers.push(close);
    return { manager: manager!, adapter, views, output, notices, events, close };
  };
  return { stateDir: root.stateDir, cwd, owners: owners.store, cleanup, hostPids, backend };
}

/** Subscribes a view that accepts screens; returns the received items. */
export async function watchPane(backend: HostE2eBackend, threadId: string, terminalId: string) {
  const screens: TerminalScreenItem[] = [];
  const output: string[] = [];
  const handle = await runEffect(
    backend.manager.subscribeSession!(
      { threadId, terminalId, acceptScreen: true },
      {
        screen: (item) => screens.push(item),
        event: (event) => {
          if (event.type === "output") output.push(event.data);
        },
        overflow: () => undefined,
      },
    ),
  );
  handle.start();
  return { screens, output, stop: () => handle.unsubscribe(0) };
}
