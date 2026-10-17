import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { vi } from "vitest";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import OwnersMigration from "../persistence/Migrations/111_RemoteAgentRuntimeBindings.ts";
import ReplayMigration from "../persistence/Migrations/112_RemoteAgentReplayFence.ts";
import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { makeTerminalManagerWithOptions } from "../terminal/Layers/Manager.ts";
import { makeRemoteAgentPtyAdapter } from "./remoteAgentPtyAdapter.ts";
import { makeOwnedRemoteAgentPty } from "./remoteAgentOwnedPty.ts";
import { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import * as Control from "./remoteAgentControl.ts";
import {
  emptyRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { restartFixtureBinding } from "./remoteAgentOwners.restart.binding.ts";
import * as SshProcess from "../ssh/sshProcess.ts";

export async function makeRemoteRestartFixture() {
  const directory = mkdtempSync(join(tmpdir(), "bigbud-explicit-restart-"));
  const binding = restartFixtureBinding("g1");
  vi.spyOn(remoteAgentAdmission, "resolveBinding").mockResolvedValue(binding);
  vi.spyOn(SshProcess, "runSshCommand").mockImplementation(async (input) => ({
    stdout: `\x1e${input.args?.[3]}\x1f`,
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  }));
  let registry: RemoteAgentRegistry = {
    ...emptyRemoteAgentRegistry(),
    builds: [
      {
        id: `${binding.runtime.version}:${binding.runtime.sha256}:${binding.runtime.targetTriple}`,
        runtime: binding.runtime,
        health: "staged",
        promotion: 0,
        binary: "present",
        authenticated: true,
      },
    ],
  };
  vi.spyOn(Control, "openRemoteAgentControl").mockResolvedValue({
    root: "/tmp/agent",
    run: async () => "",
    registry: {
      read: async () => registry,
      update: async (transition) => {
        registry = transition(registry);
        return registry;
      },
    },
  });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      NodeSqlite.layer({ filename: join(directory, "owners.sqlite") }),
      NodeServices.layer,
    ),
  );
  await runtime.runPromise(Effect.andThen(OwnersMigration, ReplayMigration));
  const store = await runtime.runPromise(makeRemoteAgentRuntimeBindings);
  let releasePersist!: () => void;
  let rejectPersist!: (error: Error) => void;
  const persistGate = new Promise<void>((resolve, reject) => {
    releasePersist = resolve;
    rejectPersist = reject;
  });
  let persisting = false;
  const update = store.update.bind(store);
  const gatedStore = {
    ...store,
    update: async (...args: Parameters<typeof store.update>) => {
      const current = await store.get(args[0]);
      if (current && args[1](current).state === "terminal") {
        persisting = true;
        await persistGate;
      }
      return update(...args);
    },
  };
  const requests: RemoteAgentFrame[] = [];
  const listeners = new Set<(frame: RemoteAgentFrame) => void>();
  const pids = new Map<string, number>();
  const pool = new RemoteAgentConnectionPool({
    create: async () =>
      ({
        handshake: async () => ({
          protocolMajor: 1,
          protocolMinor: 2,
          agentVersion: "0.2.207",
          buildDigest: "fixture",
          os: "linux",
          architecture: "aarch64",
          agentInstanceId: "g1",
          agentEpoch: binding.expectedEpoch,
          capabilities: ["terminal.pty", "workspace.files"].map((name) => ({
            name,
            major: 1,
            minor: 0,
          })),
          maxFrameBytes: 1024,
          maxOperationOutputBytes: 1024,
          maxJournalBytes: 1024,
        }),
        onFrame: (callback: (frame: RemoteAgentFrame) => void) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
        onFailure: () => () => undefined,
        close: () => undefined,
        request: async (frame: RemoteAgentFrame) => {
          requests.push(frame);
          if (frame.type === "workspaceOpenRequest")
            return { type: "workspaceOpenResponse", value: { errorCode: "" } };
          if (frame.type === "ptyCreateRequest") {
            const pid = 9000 + pids.size;
            pids.set(frame.value.ptyId, pid);
            return { type: "ptyCreateResponse", value: { accepted: true, pid } };
          }
          if (frame.type === "ptyAttachRequest")
            return {
              type: "ptyAttachResponse",
              value: { pid: pids.get(frame.value.ptyId), replayGap: false },
            };
          if (frame.type === "ptyCloseRequest")
            return { type: "ptyCloseResponse", value: { accepted: true } };
          return { type: "ptyInputResponse", value: { accepted: true } };
        },
      }) as unknown as RemoteAgentConnection,
  });
  const scope = await runtime.runPromise(Scope.make());
  const manager = await runtime.runPromise(
    makeTerminalManagerWithOptions({
      logsDir: join(directory, "logs"),
      subprocessChecker: () => Effect.succeed(false),
      ptyAdapter: makeRemoteAgentPtyAdapter(
        { spawn: () => Effect.die("Local spawn forbidden") },
        {
          resolvePty: async () => {
            throw new Error("Target-only resolution forbidden");
          },
          resolveWorkspace: async () => {
            throw new Error("Target-only resolution forbidden");
          },
          restoreOrCreate: makeOwnedRemoteAgentPty(pool, () => gatedStore),
        },
      ),
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const input = {
    threadId: "thread",
    terminalId: "terminal",
    executionTargetId: "ssh:fixture",
    cwd: "/workspace",
    cols: 80,
    rows: 24,
  };
  const opened = await runtime.runPromise(manager.open(input));
  const resource = [...pids.keys()][0]!;
  return {
    runtime,
    manager,
    input,
    opened,
    requests,
    resource,
    store,
    isPersisting: () => persisting,
    releasePersist,
    rejectPersist,
    exit: () => {
      for (const listener of listeners)
        listener({
          type: "ptyExited",
          value: { ptyId: resource, hasExitCode: true, exitCode: 0, hasSignal: false, signal: 0 },
        });
    },
    dispose: async () => {
      releasePersist();
      await runtime.runPromise(Scope.close(scope, Exit.void));
      pool.closeAll();
      await runtime.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
