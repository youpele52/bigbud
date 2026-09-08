import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import OwnersMigration from "../persistence/Migrations/111_RemoteAgentRuntimeBindings.ts";
import ReplayMigration from "../persistence/Migrations/112_RemoteAgentReplayFence.ts";
const Migration = Effect.andThen(OwnersMigration, ReplayMigration);
import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { makeTerminalManagerWithOptions } from "../terminal/Layers/Manager.ts";
import { makeRemoteAgentPtyAdapter } from "./remoteAgentPtyAdapter.ts";
import { makeOwnedRemoteAgentPty } from "./remoteAgentOwnedPty.ts";
import {
  RemoteAgentConnectionPool,
  type RemoteAgentRuntimeBinding,
} from "./remoteAgentConnectionPool.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import * as Control from "./remoteAgentControl.ts";
import {
  emptyRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { ThreadId } from "@bigbud/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { configureRemoteAgentOwners } from "./remoteAgentOwners.ts";
import { makeOwnedRemoteAgentProcess } from "./remoteAgentOwnedProcess.ts";
import { makeRemoteAgentToolRunner } from "./remoteAgentToolRunner.ts";
import { RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import * as RemoteDefault from "./remoteAgentDefault.ts";
import { runRestartFixtureTool } from "./remoteAgentOwners.httpFixture.ts";

vi.mock("../ssh/sshVerification.ts", () => ({ assertSshExecutionTargetReady: () => undefined }));
vi.mock("../ssh/sshCommand.ts", () => ({
  buildSshCommandInvocation: () => ({ command: "fixture", args: [] }),
}));
afterEach(() => vi.restoreAllMocks());

function binding(generation: string): RemoteAgentRuntimeBinding {
  const sha256 = (generation === "g1" ? "a" : "b").repeat(64);
  return {
    expectedEpoch: `epoch-${generation}`,
    runtime: {
      generation,
      version: "0.2.207",
      sha256,
      buildDigest: "fixture",
      targetTriple: "aarch64-unknown-linux-gnu",
      origin: "managed",
      binaryPath: `/tmp/agent/bin/0.2.207/${sha256}/bigbud-remote-agent`,
      statePath: `/tmp/agent/runtimes/${generation}`,
      socketPath: `/tmp/agent/runtimes/${generation}/supervisor.sock`,
      logPath: `/tmp/agent/runtimes/${generation}/supervisor.log`,
    },
  };
}

describe("application terminal owner recovery after server services restart", () => {
  it("restores a retryable tool invocation on its original runtime without persisting command secrets or redispatching", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-runner-restart-"));
    const old = binding("g1");
    const selection = vi.spyOn(remoteAgentAdmission, "resolveBinding").mockResolvedValue(old);
    const id = `${old.runtime.version}:${old.runtime.sha256}:${old.runtime.targetTriple}`;
    let registry: RemoteAgentRegistry = {
      ...emptyRemoteAgentRegistry(),
      builds: [
        {
          id,
          runtime: old.runtime,
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
    let dispatches = 0;
    let operationId = "";
    let disconnected = false;
    const generations: string[] = [];
    const controllers: Array<{ dispose: () => Promise<void> }> = [];
    try {
      for (let restart = 0; restart < 2; restart++) {
        const runtime = ManagedRuntime.make(
          NodeSqlite.layer({ filename: join(directory, "owners.sqlite") }),
        );
        controllers.push(runtime);
        if (!restart) await runtime.runPromise(Migration);
        configureRemoteAgentOwners(await runtime.runPromise(makeRemoteAgentRuntimeBindings));
        const pool = new RemoteAgentConnectionPool({
          create: async (_target, route) => {
            generations.push(route!.runtime.generation);
            const frames: RemoteAgentFrame[] = [];
            return {
              handshake: async () => ({
                protocolMajor: 1,
                protocolMinor: 2,
                agentVersion: "0.2.207",
                buildDigest: "fixture",
                os: "linux",
                architecture: "aarch64",
                agentInstanceId: "instance",
                agentEpoch: route!.expectedEpoch,
                capabilities: ["workspace.files", "process.run", "process.attach"].map((name) => ({
                  name,
                  major: 1,
                  minor: 0,
                })),
                maxFrameBytes: 1024,
                maxJournalBytes: 1024,
                maxOperationOutputBytes: 1024,
              }),
              close: () => undefined,
              onFailure: () => () => undefined,
              request: async (frame: RemoteAgentFrame) => {
                if (frame.type === "workspaceOpenRequest")
                  return { type: "workspaceOpenResponse", value: { errorCode: "" } };
                if (frame.type !== "processRequest") throw new Error("Unexpected mutation");
                dispatches++;
                operationId = frame.value.operationId;
                disconnected = true;
                return { type: "processAccepted", value: { accepted: true, duplicate: false } };
              },
              send: async (frame: RemoteAgentFrame) => {
                if (disconnected) throw new RemoteAgentConnectionError("controller transport lost");
                if (frame.type === "processAttachRequest") {
                  expect(frame.value.operationId).toBe(operationId);
                  frames.push(
                    {
                      type: "processAttachResponse",
                      value: {
                        requestId: frame.value.requestId,
                        operationId,
                        state: "completed",
                        nextSequence: 2,
                        firstRetainedSequence: 1,
                      },
                    },
                    {
                      type: "processOutput",
                      value: {
                        operationId,
                        sequence: 1,
                        stream: "stdout",
                        bytes: new TextEncoder().encode("restored-result"),
                      },
                    },
                    {
                      type: "processCompleted",
                      value: {
                        requestId: frame.value.requestId,
                        operationId,
                        state: "completed",
                        hasExitCode: true,
                        exitCode: 0,
                        outputTruncated: false,
                        errorCode: "",
                        errorMessage: "",
                      },
                    },
                  );
                }
              },
              nextFrame: async () => {
                if (disconnected) throw new RemoteAgentConnectionError("controller transport lost");
                return frames.shift()!;
              },
            } as unknown as RemoteAgentConnection;
          },
        });
        const runner = makeRemoteAgentToolRunner({
          resolve: async () => {
            throw new Error("Target-default resolution forbidden");
          },
          runOwned: makeOwnedRemoteAgentProcess(pool),
        });
        vi.spyOn(RemoteDefault, "getConfiguredRemoteAgentComposition").mockReturnValue({
          toolRunner: runner,
        } as never);
        if (!restart)
          await expect(runRestartFixtureTool("stable-invocation")).rejects.toThrow(
            "transport lost",
          );
        else
          expect((await runRestartFixtureTool("stable-invocation")).stdout).toBe("restored-result");
        const rows = await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{
              route_json: string;
            }>`SELECT route_json FROM remote_agent_runtime_owners`;
          }),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.route_json).not.toContain("secret-command");
        expect(rows[0]!.route_json).not.toContain("secret-file-content");
        pool.closeAll();
        await runtime.dispose();
        disconnected = false;
        selection.mockResolvedValue(binding("g2"));
      }
      expect(dispatches).toBe(1);
      expect(selection).toHaveBeenCalledOnce();
      expect(generations.every((generation) => generation === "g1")).toBe(true);
    } finally {
      for (const controller of controllers) await controller.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reopens through the durable old PTY identity after newer activation; never spawns a replacement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-owner-restart-"));
    const old = binding("g1");
    const newer = binding("g2");
    const selection = vi.spyOn(remoteAgentAdmission, "resolveBinding").mockResolvedValue(old);
    let registry: RemoteAgentRegistry = {
      ...emptyRemoteAgentRegistry(),
      builds: [old, newer].map((value) => ({
        id: remoteAgentBuildId(value.runtime),
        runtime: value.runtime,
        health: "staged" as const,
        promotion: 0,
        authenticated: true,
        binary: "present" as const,
      })),
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
    const ptys = new Map<string, string>();
    const requests: Array<{ generation: string; frame: RemoteAgentFrame }> = [];
    const makePool = () =>
      new RemoteAgentConnectionPool({
        create: async (_target, route) =>
          ({
            handshake: async () => ({
              protocolMajor: 1,
              protocolMinor: 2,
              agentVersion: "0.2.207",
              buildDigest: "fixture",
              os: "linux",
              architecture: "aarch64",
              agentInstanceId: route!.runtime.generation,
              agentEpoch: route!.expectedEpoch,
              capabilities: ["terminal.pty", "workspace.files"].map((name) => ({
                name,
                major: 1,
                minor: 0,
              })),
              maxFrameBytes: 1024,
              maxOperationOutputBytes: 1024,
              maxJournalBytes: 1024,
            }),
            onFrame: () => () => undefined,
            onFailure: () => () => undefined,
            close: () => undefined,
            request: async (frame: RemoteAgentFrame) => {
              const generation = route!.runtime.generation;
              requests.push({ generation, frame });
              if (frame.type === "workspaceOpenRequest")
                return { type: "workspaceOpenResponse", value: { errorCode: "" } };
              if (frame.type === "ptyCreateRequest") {
                ptys.set(frame.value.ptyId, generation);
                return { type: "ptyCreateResponse", value: { accepted: true, pid: 9000 } };
              }
              if (frame.type === "ptyAttachRequest") {
                if (ptys.get(frame.value.ptyId) !== generation)
                  throw new Error("Unknown original PTY");
                return { type: "ptyAttachResponse", value: { pid: 9000, replayGap: false } };
              }
              return { type: "ptyInputResponse", value: { accepted: true } };
            },
          }) as unknown as RemoteAgentConnection,
      });
    const dbLayer = () =>
      Layer.mergeAll(
        NodeSqlite.layer({ filename: join(directory, "owners.sqlite") }),
        NodeServices.layer,
      );
    const controllers: Array<{ dispose: () => Promise<void> }> = [];
    try {
      for (let restart = 0; restart < 2; restart++) {
        const runtime = ManagedRuntime.make(dbLayer());
        controllers.push(runtime);
        if (!restart) await runtime.runPromise(Migration);
        const store = await runtime.runPromise(makeRemoteAgentRuntimeBindings);
        const pool = makePool();
        const scope = await runtime.runPromise(Scope.make());
        const adapter = makeRemoteAgentPtyAdapter(
          { spawn: () => Effect.die("Local spawn forbidden") },
          {
            resolvePty: async () => {
              throw new Error("Target-only PTY resolution forbidden");
            },
            resolveWorkspace: async () => {
              throw new Error("Target-only workspace resolution forbidden");
            },
            restoreOrCreate: makeOwnedRemoteAgentPty(pool, () => store),
          },
        );
        const manager = await runtime.runPromise(
          makeTerminalManagerWithOptions({
            logsDir: join(directory, "logs"),
            ptyAdapter: adapter,
            subprocessChecker: () => Effect.succeed(false),
          }).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        const result = await runtime.runPromise(
          manager.open({
            threadId: ThreadId.makeUnsafe("thread"),
            terminalId: "terminal",
            executionTargetId: "ssh:fixture",
            cwd: "/workspace",
          }),
        );
        expect(result.pid).toBe(9000);
        await runtime.runPromise(Scope.close(scope, Exit.void));
        pool.closeAll();
        await runtime.dispose();
        selection.mockResolvedValue(newer);
      }
      expect(requests.filter((entry) => entry.frame.type === "ptyCreateRequest")).toHaveLength(1);
      expect(requests.filter((entry) => entry.frame.type === "ptyAttachRequest")).toHaveLength(2);
      expect(requests.every((entry) => entry.generation === "g1")).toBe(true);
      expect(selection).toHaveBeenCalledOnce();
      expect(requests.some((entry) => entry.frame.type === "ptySignalRequest")).toBe(false);
    } finally {
      for (const controller of controllers) await controller.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
