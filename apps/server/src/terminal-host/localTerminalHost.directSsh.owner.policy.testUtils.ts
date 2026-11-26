/** Shared fixture for native direct SSH terminal policy tests (mocked owner port, real SQLite). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, vi } from "vitest";

import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import OwnersMigration from "../persistence/Migrations/111_RemoteAgentRuntimeBindings.ts";
import ReplayMigration from "../persistence/Migrations/112_RemoteAgentReplayFence.ts";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import type { RemoteAgentOwner } from "../remote-agent/remoteAgentOwners.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import {
  hostedDirectShellOwner,
  type HostedDirectShellOwner,
} from "../terminal/Layers/DirectShellLaunch.hosted.ts";
import type { settleHostedDirectShellPane } from "../terminal/Layers/Manager.shell.direct.settle.ts";
import type { PtySpawnInput } from "../terminal/Services/PTY.ts";
import type {
  NativeDirectSshTerminalBinding,
  NativeDirectSshTerminalOwner,
} from "./localTerminalHost.directSsh.owner.port.ts";
import { makeNativeDirectSshTerminal } from "./localTerminalHost.directSsh.owner.ts";

export const targetId = "ssh:host=fixture.invalid&transport=direct-ssh";
export const pane = { threadId: "thread", terminalId: "pane" };
export const ownerKey = JSON.stringify([pane.threadId, pane.terminalId]);
const routeKey = `terminal:${ownerKey}`;
export const input: PtySpawnInput = {
  ownerKey,
  executionTargetId: targetId,
  remoteCwd: "/srv/work",
  cwd: "/local",
  cols: 80,
  rows: 24,
  shell: "/legacy/ssh",
  args: [],
  env: {},
};
export const first: NativeDirectSshTerminalBinding = {
  targetId,
  ownerEpoch: "epoch",
  targetGeneration: "generation-1",
  leaseId: "lease-1",
};
export const runtime = {
  generation: "native-runtime",
  version: "0.1.0",
  sha256: "a".repeat(64),
  buildDigest: "fixture",
  targetTriple: "aarch64-unknown-linux-musl",
  origin: "legacy-external",
  binaryPath: "/test/bigbud-ssh-owner",
  statePath: "/test/owner-state",
  socketPath: "/test/owner-state/supervisor.sock",
  logPath: "/test/owner-state/supervisor.log",
} as RemoteAgentRuntime;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

export async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "bigbud-native-policy-"));
  const database = ManagedRuntime.make(
    NodeSqlite.layer({ filename: join(directory, "owners.sqlite") }),
  );
  cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
  cleanup.push(() => database.dispose());
  await database.runPromise(Effect.andThen(OwnersMigration, ReplayMigration));
  const store = await database.runPromise(makeRemoteAgentRuntimeBindings);
  const process = {
    pid: 7,
    detach: vi.fn(),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    onExit: () => () => {},
    onData: () => () => {},
  };
  const port = {
    prepareOpen: vi.fn<NativeDirectSshTerminalOwner["prepareOpen"]>(async () => first),
    open: vi.fn<NativeDirectSshTerminalOwner["open"]>(async (_i, binding) => ({
      binding,
      process,
    })),
    reattach: vi.fn<NativeDirectSshTerminalOwner["reattach"]>(async (binding) => ({
      binding,
      process,
    })),
    status: vi.fn<NativeDirectSshTerminalOwner["status"]>(async (binding) => ({
      binding,
      state: "live",
    })),
    close: vi.fn<NativeDirectSshTerminalOwner["close"]>(async (binding) => ({
      binding,
      state: "exited",
    })),
  } satisfies NativeDirectSshTerminalOwner;
  let closed = false;
  const native = makeNativeDirectSshTerminal(
    { port, owners: () => store, runtime },
    (id) => id === targetId,
    () => closed,
  );
  const lifecycle = native.runtimeForTarget(targetId)!.localSshClient!;
  let hosted: HostedDirectShellOwner | undefined = hostedDirectShellOwner({
    ...pane,
    executionTargetId: targetId,
  });
  const ctx = {
    resolveOwnedRuntime: (id: string) => native.runtimeForTarget(id),
    directShellOwners: {
      getHosted: async () => hosted,
      listHostedForThread: async () => (hosted ? [hosted] : []),
      releaseHosted: async (record: HostedDirectShellOwner) => {
        if (hosted?.reservationId !== record.reservationId) return false;
        hosted = undefined;
        return true;
      },
    },
  } as unknown as Parameters<typeof settleHostedDirectShellPane>[0];
  return {
    store,
    port,
    native,
    lifecycle,
    ctx,
    hosted: () => hosted,
    route: () => store.get(routeKey),
    closeOwner: () => {
      closed = true;
    },
  };
}

/** A later lease for the same pane, as a restart or replacement would record it. */
export type PolicyFixture = Awaited<ReturnType<typeof setup>>;

export const replace = async (f: PolicyFixture, old: RemoteAgentOwner) =>
  f.store.reserve(
    {
      ...old,
      reservationId: "replacement-reservation",
      connectionId: "ssh-owner:generation-2",
      resourceId: "lease-2",
      state: "may-have-been-sent",
    },
    true,
    targetId,
  );
