import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";

import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import { TerminalViewRegistry } from "../terminal/activity/terminalViewRegistry.ts";
import { makeTerminalManagerWithOptions } from "../terminal/Layers/Manager.process.ts";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { makeSshOwnerDevTerminal } from "./sshOwnerDevTerminal.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn || process.platform !== "darwin")(
  "C07 retains the exact native pane as host-lost after the test-owned owner dies",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ allowInteractiveShell: true });
    try {
      const options = await proofOptions(fixture, undefined, true);
      const binaryPath = path.join(fixture.root, "picker-owner");
      const sha256 = createHash("sha256")
        .update(await readFile(binaryPath))
        .digest("hex");
      const launcher = path.join(fixture.root, "start-interactive-owner");
      await writeFile(
        launcher,
        `#!/bin/sh\nexec '${options.binary}' "$@" --dev-interactive-terminal\n`,
        {
          mode: 0o700,
        },
      );
      const targetId = options.targetId.replace("transport=agent", "transport=direct-ssh");
      const database = path.join(fixture.root, "manager-owner-crash.sqlite");
      const pane = {
        threadId: "crash-thread",
        terminalId: "crash-pane",
        executionTargetId: targetId,
        cwd: fixture.folder,
        cols: 80,
        rows: 24,
      };
      const key = `terminal:${JSON.stringify([pane.threadId, pane.terminalId])}`;
      await fixture.start();
      vi.stubEnv("HOME", fixture.home);
      vi.stubEnv("PATH", fixture.env.PATH);
      await storageScope(database, (sql) =>
        Effect.gen(function* () {
          const store = yield* makeRemoteAgentRuntimeBindings.pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          const readerRuntime = yield* Effect.acquireRelease(
            Effect.sync(() => ManagedRuntime.make(NodeSqlite.layer({ filename: database }))),
            (runtime) => Effect.promise(() => runtime.dispose()),
          );
          const reader = yield* Effect.promise(() =>
            readerRuntime.runPromise(makeRemoteAgentRuntimeBindings),
          );
          const startOwner = vi.fn((profileBinding: Uint8Array) =>
            startPickerProofOwner({
              ...options,
              profileBinding,
              binary: launcher,
              sql,
              targetId,
              workspaceRoot: fixture.folder,
            }),
          );
          const picker = makeSshOwnerDevPicker({
            executionTargetId: targetId,
            host: fixture.host,
            startOwner,
          });
          yield* Effect.acquireRelease(Effect.void, () => Effect.promise(picker.close));
          const owner = yield* Effect.promise(async () => {
            const trust = await picker.inspectTrust({ executionTargetId: targetId });
            if (trust.state !== "approvalRequired")
              throw new Error("Expected isolated first-use trust");
            await picker.trustSshHost({
              executionTargetId: targetId,
              challengeId: trust.challenge.challengeId,
            });
            return picker.withOwner(targetId, async (owner) => owner);
          });
          const prepare = vi.spyOn(owner, "prepareProofTerminal");
          const open = vi.spyOn(owner, "openReservedProofTerminal");
          const legacyOpen = vi.spyOn(owner, "openProofTerminal");
          const close = vi.spyOn(owner, "closeProofTerminal");
          const probe = vi.spyOn(owner, "probeProofTerminalCwd");
          let crashBoundary: Promise<void> | undefined;
          const dev = makeSshOwnerDevTerminal({
            targetId,
            workspaceRoot: fixture.folder,
            withOwner: async (id, use) => {
              if (crashBoundary) await crashBoundary;
              return picker.withOwner(id, use);
            },
            owners: () => store,
            runtime: {
              generation: "manager-owner-crash-fixture",
              version: "0.1.0",
              sha256,
              buildDigest: sha256,
              targetTriple:
                process.arch === "arm64"
                  ? "aarch64-unknown-linux-musl"
                  : "x86_64-unknown-linux-musl",
              origin: "legacy-external",
              binaryPath,
              statePath: fixture.root,
              socketPath: path.join(fixture.root, "supervisor.sock"),
              logPath: path.join(fixture.root, "supervisor.log"),
            },
          });
          const fallback = vi.fn(() => Effect.die("legacy PTY fallback was called"));
          const adapter = dev.wrapPtyAdapter({ spawn: fallback });
          const spawn = vi.spyOn(adapter, "spawn");
          const makeManager = () =>
            makeTerminalManagerWithOptions({
              logsDir: path.join(fixture.root, "logs"),
              ptyAdapter: adapter,
              directSshCwdOwner: dev.cwdOwner,
              agentDetector: () => Effect.succeed(new Map()),
              subprocessPollIntervalMs: 60_000,
              views: new TerminalViewRegistry(),
              resolveQuitIntent: Effect.succeed(Option.none()),
            });
          const manager = yield* makeManager();
          let output = "";
          const error = vi.fn();
          const exited = vi.fn();
          const restarted = vi.fn();
          yield* manager.subscribe((event) =>
            Effect.sync(() => {
              if (event.type === "output") output += event.data;
              if (event.type === "error") error(event);
              if (event.type === "exited") exited(event);
              if (event.type === "restarted") restarted(event);
            }),
          );
          const original = yield* manager.open(pane);
          expect(original.status).toBe("running");
          yield* manager.write({
            ...pane,
            expectedGeneration: original.runtimeGeneration,
            data: "printf '<%s>\\n' \"$((20 + 3))\"\r",
          });
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(output).toMatch(/\r?\n<23>\r?\n/), 5_000),
          );
          const route = yield* Effect.promise(() => reader.get(key));
          if (!route) throw new Error("Missing committed native pane reservation");
          expect(route).toMatchObject({
            state: "may-have-been-sent",
            target: targetId,
            terminalCwd: pane.cwd,
            epoch: Buffer.from(owner.ownerEpoch).toString("hex"),
          });
          const lease = Buffer.from(route.resourceId, "hex");
          expect(open).toHaveBeenCalledExactlyOnceWith(lease);
          const starts = fixture.connectionStarts();
          const accepted = fixture.acceptedPublicKeys();
          const probes = probe.mock.calls.length;

          // Drain admitted owner calls and hold later polls until SIGKILL and child exit are
          // confirmed. In particular, don't let killForTest's local pipe retirement alone pass.
          const boundary = Promise.withResolvers<void>();
          crashBoundary = boundary.promise;
          yield* Effect.promise(async () => {
            try {
              await picker.withOwner(targetId, async (client) => {
                const live = await client.proofTerminalStatus(lease);
                expect(Buffer.from(live.lease)).toEqual(lease);
                expect(live).toMatchObject({ pid: original.pid, live: true });
                await client.killForTest();
              });
              expect(await reader.get(key)).toEqual(route);
              expect(error).not.toHaveBeenCalled();
            } finally {
              boundary.resolve();
            }
          });
          yield* Effect.promise(() =>
            vi.waitFor(
              () =>
                expect(error).toHaveBeenCalledExactlyOnceWith(
                  expect.objectContaining({
                    runtimeGeneration: original.runtimeGeneration,
                    message: expect.stringContaining("sshOwnerUnavailable"),
                  }),
                ),
              5_000,
            ),
          );
          const lost = { ...route, state: "outcome-unknown" };
          expect(yield* Effect.promise(() => reader.get(key))).toEqual(lost);
          const lostSnapshot = {
            status: "error",
            endedReason: "host-lost",
            pid: null,
            exitCode: null,
            exitSignal: null,
          };
          expect(yield* manager.snapshot(pane)).toMatchObject({
            ...lostSnapshot,
            runtimeGeneration: original.runtimeGeneration,
          });
          expect(yield* manager.open({ ...pane, attachOnly: true })).toMatchObject(lostSnapshot);
          const restart = {
            ...pane,
            operationId: "refuse-replacement",
            shellSelection: { kind: "legacy-auto" } as const,
          };
          expect(
            yield* Effect.flip(
              manager.restart({ ...restart, expectedGeneration: original.runtimeGeneration }),
            ),
          ).toMatchObject({
            _tag: "TerminalExecutionTargetError",
            detail: expect.stringContaining("sshOwnerUnavailable"),
          });
          expect(yield* Effect.flip(manager.close(pane))).toMatchObject({
            _tag: "TerminalExecutionTargetError",
            detail: expect.stringContaining("could not confirm termination"),
          });
          // A new manager has no in-memory pane; reopen must honor the committed loss marker.
          const cold = yield* makeManager();
          expect(yield* cold.open({ ...pane, attachOnly: true })).toMatchObject(lostSnapshot);
          expect(yield* cold.open(pane)).toMatchObject(lostSnapshot);
          expect(yield* Effect.flip(cold.restart(restart))).toMatchObject({
            _tag: "TerminalExecutionTargetError",
            detail: expect.stringContaining("sshOwnerUnavailable"),
          });
          expect(yield* Effect.flip(cold.close({ ...pane, deleteHistory: true }))).toMatchObject({
            _tag: "TerminalExecutionTargetError",
            detail: expect.stringContaining("sshOwnerUnavailable"),
          });
          const lifecycle = adapter.ownedRuntimeForTarget?.(targetId)?.localSshClient;
          if (!lifecycle) throw new Error("Missing exact native lifecycle");
          expect(yield* Effect.promise(() => lifecycle.status(route))).toBe("unknown");
          expect(yield* Effect.promise(() => reader.get(key))).toEqual(lost);
          expect(exited).not.toHaveBeenCalled();
          expect(restarted).not.toHaveBeenCalled();
          expect(prepare).toHaveBeenCalledOnce();
          expect(open).toHaveBeenCalledOnce();
          expect(close).not.toHaveBeenCalled();
          expect(legacyOpen).not.toHaveBeenCalled();
          expect(fallback).not.toHaveBeenCalled();
          expect(spawn).toHaveBeenCalledOnce();
          expect(startOwner).toHaveBeenCalledOnce();
          expect(probe).toHaveBeenCalledTimes(probes);
          expect(fixture.connectionStarts()).toBe(starts);
          expect(fixture.acceptedPublicKeys()).toBe(accepted);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    } finally {
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  60_000,
);
