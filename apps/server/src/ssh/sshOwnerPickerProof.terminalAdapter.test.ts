import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";

import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { makeNativeDirectSshTerminal } from "../terminal-host/localTerminalHost.directSsh.owner.ts";
import { nativeDirectSshBinding } from "../terminal-host/localTerminalHost.directSsh.owner.lifecycle.ts";
import { isDirectSshTerminalTarget } from "../terminal-host/localTerminalHost.directSsh.ts";
import type { PtySequencedData, PtySpawnInput } from "../terminal/Services/PTY.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import type { PickerProofTerminalReplay } from "./sshOwnerPickerProof.codec.terminal.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makePickerProofTerminalAdapter } from "./sshOwnerPickerProof.terminalAdapter.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

const text = (events: ReadonlyArray<PtySequencedData>) =>
  events.map((event) => event.data).join("");

it.skipIf(!pickerProofOptedIn)(
  "reattaches the same retained SSH pane and replays real PTY output without replacement",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ allowPty: true });
    try {
      const options = await proofOptions(fixture, undefined, true);
      const targetId = options.targetId.replace("transport=agent", "transport=direct-ssh");
      const binaryPath = path.join(fixture.root, "picker-owner");
      const sha256 = createHash("sha256")
        .update(await readFile(binaryPath))
        .digest("hex");
      // The existing local-host store encodes local architecture using a legacy Linux triple.
      const runtime: RemoteAgentRuntime = {
        generation: "picker-proof",
        version: "0.1.0",
        sha256,
        buildDigest: sha256,
        targetTriple:
          process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl",
        origin: "legacy-external",
        binaryPath,
        statePath: fixture.root,
        socketPath: path.join(fixture.root, "supervisor.sock"),
        logPath: path.join(fixture.root, "supervisor.log"),
      };
      const db = path.join(fixture.root, "terminal-adapter.sqlite");
      await fixture.start();
      vi.stubEnv("HOME", fixture.home);
      vi.stubEnv("PATH", fixture.env.PATH);
      const exercise = async (sql: SqlClient.SqlClient) => {
        const store = await Effect.runPromise(
          makeRemoteAgentRuntimeBindings.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        );
        const reader = ManagedRuntime.make(NodeSqlite.layer({ filename: db }));
        try {
          const independent = await reader.runPromise(makeRemoteAgentRuntimeBindings);
          const owner = await startPickerProofOwner({
            ...options,
            targetId,
            sql,
            workspaceRoot: fixture.folder,
          });
          try {
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired")
              throw new Error("Expected isolated first-use trust");
            await owner.approveTrust(trust.challenge);
            await vi.waitFor(() => expect(fixture.connectionStarts()).toBeGreaterThanOrEqual(2));
            const idleConnections = fixture.connectionStarts();
            const prepare = vi.spyOn(owner, "prepareProofTerminal");
            const status = vi.spyOn(owner, "proofTerminalStatus");
            const close = vi.spyOn(owner, "closeProofTerminal");
            const resize = vi.spyOn(owner, "resizeProofTerminal");
            const write = vi.spyOn(owner, "writeProofTerminalInput");
            const replay = vi.spyOn(owner, "replayProofTerminal");
            const rawOpen = vi.spyOn(owner, "openProofTerminal");
            const ownerKey = JSON.stringify(["thread-fixture", "pane-fixture"]);
            const routeKey = `terminal:${ownerKey}`;
            const openReserved = owner.openReservedProofTerminal;
            const open = vi
              .spyOn(owner, "openReservedProofTerminal")
              .mockImplementation(async (lease) => {
                const prepared = await prepare.mock.results[0]?.value;
                // Read the committed row on another SQLite connection before allowing the real RPC.
                expect(await independent.get(routeKey)).toMatchObject({
                  target: targetId,
                  state: "may-have-been-sent",
                  epoch: Buffer.from(prepared.ownerEpoch).toString("hex"),
                  connectionId: `ssh-owner:${Buffer.from(prepared.targetGeneration).toString("hex")}`,
                  resourceId: Buffer.from(lease).toString("hex"),
                  terminalCwd: fixture.folder,
                });
                expect(lease).toEqual(Buffer.from(prepared.lease));
                expect(fixture.connectionStarts()).toBe(idleConnections);
                return openReserved(lease);
              });
            const { port, sample } = makePickerProofTerminalAdapter(owner, targetId);
            const adapter = (owners: typeof store) =>
              makeNativeDirectSshTerminal(
                { port, owners: () => owners, runtime },
                isDirectSshTerminalTarget,
                () => false,
              );
            const first = adapter(store);
            const input: PtySpawnInput = {
              ownerKey,
              executionTargetId: targetId,
              remoteCwd: fixture.folder,
              cwd: fixture.home,
              shell: path.join(fixture.root, "no-legacy-shell"),
              args: [],
              env: {},
              cols: 96,
              rows: 34,
            };
            const recover = { ...input, recoverOnly: true };
            await expect(Effect.runPromise(first.spawn(recover))).rejects.toThrow(
              "no retained native SSH binding",
            );
            expect(await independent.get(routeKey)).toBeUndefined();
            expect(prepare).not.toHaveBeenCalled();
            expect(open).not.toHaveBeenCalled();
            expect(status).not.toHaveBeenCalled();
            expect(fixture.connectionStarts()).toBe(idleConnections);

            const proofOpen = vi.spyOn(port, "open");
            const pty = await Effect.runPromise(first.spawn(input)).catch(
              async (cause: unknown) => {
                await proofOpen.mock.results[0]?.value;
                throw cause;
              },
            );
            try {
              const route = await independent.get(routeKey);
              if (!route) throw new Error("Missing durable pane reservation");
              const binding = nativeDirectSshBinding(route);
              const signal = new AbortController().signal;
              const nativeLease = Buffer.from(binding.leaseId, "hex");
              const ioError = vi.fn();
              pty.onError?.(ioError);
              expect(pty).toMatchObject({
                remoteResourceId: binding.leaseId,
                recovered: false,
              });
              const live: PtySequencedData[] = [];
              const unlisten = pty.onSequencedData?.((event) => live.push(event));
              const size = "BIGBUD_SSH_OWNER_PROOF_PTY_SIZE:34 96";
              const echo = "BIGBUD_SSH_OWNER_PROOF_PTY_ECHO:";
              await vi.waitFor(() => expect(text(live)).toContain(size));
              pty.write("literal ; proof adapter\n");
              await vi.waitFor(() =>
                expect(text(live)).toContain(`${echo}literal ; proof adapter`),
              );
              pty.resize(101, 41);
              await vi.waitFor(() =>
                expect(resize).toHaveBeenCalledExactlyOnceWith(nativeLease, 101, 41),
              );
              await expect(resize.mock.results[0]?.value).resolves.toMatchObject({
                pid: pty.pid,
                live: true,
              });
              unlisten?.();
              pty.write("unobserved before detach\n");
              await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
              await expect(write.mock.results[1]?.value).resolves.toMatchObject({ pid: pty.pid });
              expect(ioError).not.toHaveBeenCalled();
              pty.detach?.();
              await vi.waitFor(async () => {
                const receipt = await sample(binding, signal);
                expect(receipt).toMatchObject({ pid: pty.pid, live: true });
                expect(Buffer.from(receipt.sample).toString()).toContain(
                  `${echo}unobserved before detach`,
                );
              });
              expect(text(live)).not.toContain("unobserved before detach");
              expect(close).not.toHaveBeenCalled();

              const retainedAdapter = adapter(independent);
              const lifecycle = retainedAdapter.runtimeForTarget(targetId)?.localSshClient;
              if (!lifecycle) throw new Error("Missing native SSH lifecycle");
              status.mockClear();
              await expect(
                Effect.runPromise(
                  retainedAdapter.spawn({ ...recover, expectedRemoteResourceId: "wrong-lease" }),
                ),
              ).rejects.toThrow("no matching recoverable");
              expect(status).not.toHaveBeenCalled();
              replay.mockClear();
              const recoveredInput = { ...recover, expectedRemoteResourceId: binding.leaseId };
              const resumed = await Effect.runPromise(retainedAdapter.spawn(recoveredInput));
              try {
                expect(resumed).toMatchObject({
                  pid: pty.pid,
                  recovered: true,
                  remoteResourceId: binding.leaseId,
                });
                expect(resumed.screen).toBeUndefined();
                expect(status).toHaveBeenCalledExactlyOnceWith(nativeLease);
                expect(replay).toHaveBeenCalledExactlyOnceWith(nativeLease, 0);
                const coldCut: PickerProofTerminalReplay | undefined =
                  await replay.mock.results[0]?.value;
                if (!coldCut || coldCut.gap) throw new Error("Missing complete owner replay cut");
                const after = coldCut.nextSequence - 1;
                await expect(owner.replayProofTerminal(nativeLease, after)).resolves.toMatchObject({
                  gap: false,
                  chunks: [],
                  nextSequence: coldCut.nextSequence,
                });
                await expect(
                  owner.replayProofTerminal(nativeLease, Number.MAX_SAFE_INTEGER),
                ).rejects.toMatchObject({
                  code: "invalidOperands",
                });
                expect(await independent.get(routeKey)).toEqual(route);
                const events: PtySequencedData[] = [];
                const unlistenResumed = resumed.onSequencedData?.((event) => events.push(event));
                await vi.waitFor(() => {
                  expect(text(events)).toContain(`${echo}unobserved before detach`);
                });
                expect(events.slice(0, live.length)).toEqual(live);
                expect(events.slice(0, coldCut.nextSequence - 1)).toEqual(
                  coldCut.chunks.map(({ sequence, data }) => ({
                    sequence,
                    data: Buffer.from(data).toString(),
                  })),
                );
                expect(text(events)).toContain(size);
                resumed.write("after attach\n");
                await vi.waitFor(() => expect(text(events)).toContain(`${echo}after attach`));
                expect(events.map((event) => event.sequence)).toEqual(events.map((_, i) => i + 1));
                expect(replay.mock.calls.some(([, cursor]) => cursor > 0)).toBe(true);
                expect(write).toHaveBeenNthCalledWith(
                  3,
                  nativeLease,
                  3,
                  Buffer.from("after attach\n"),
                );
                unlistenResumed?.();

                // Overflow the actual owner ring while there is no observer. A cold attach
                // must reject the retained suffix, without modifying the durable route.
                // Keep each line below the macOS PTY canonical input limit.
                // Multiple confirmed echoes still exceed the native 64 KiB ring.
                for (let i = 1; i <= 270; i++) {
                  const tail = `-overflow-${i}-end`;
                  resumed.write(`${"x".repeat(220)}${tail}\n`);
                  await vi.waitFor(async () => {
                    const receipt = await sample(binding, signal);
                    expect(Buffer.from(receipt.sample).toString()).toContain(tail);
                  });
                }
              } finally {
                resumed.detach?.();
              }
              replay.mockClear();
              await expect(
                Effect.runPromise(retainedAdapter.spawn(recoveredInput)),
              ).rejects.toThrow("no replacement was started");
              expect(replay).toHaveBeenCalledExactlyOnceWith(nativeLease, 0);
              await expect(replay.mock.results[0]?.value).resolves.toMatchObject({ gap: true });
              expect(await independent.get(routeKey)).toEqual(route);
              await expect(lifecycle.status(route)).resolves.toBe("live");
              await expect(
                lifecycle.close({ ...route, resourceId: "wrong-lease" }),
              ).rejects.toThrow("stays reserved");
              expect(close).not.toHaveBeenCalled();
              await lifecycle.close(route);
              expect(close).toHaveBeenCalledExactlyOnceWith(nativeLease);
              await expect(close.mock.results[0]?.value).resolves.toMatchObject({
                pid: pty.pid,
                live: false,
              });
              expect(await independent.get(routeKey)).toEqual({ ...route, state: "terminal" });
              await expect(owner.proofTerminalStatus(nativeLease)).rejects.toMatchObject({
                code: "operationDenied",
              });
              await expect(Effect.runPromise(retainedAdapter.spawn(recover))).rejects.toThrow(
                "no matching recoverable",
              );
              await expect(Effect.runPromise(retainedAdapter.spawn(input))).rejects.toThrow(
                "no matching recoverable",
              );
              expect(prepare).toHaveBeenCalledTimes(1);
              expect(open).toHaveBeenCalledTimes(1);
              expect(rawOpen).not.toHaveBeenCalled();
              expect(fixture.connectionStarts()).toBe(idleConnections + 1);
              expect(fixture.acceptedPublicKeys()).toBe(1);
              expect(await fixture.launchNames()).toEqual([]);
            } finally {
              pty.detach?.();
            }
          } finally {
            await owner.close();
          }
        } finally {
          await reader.dispose();
        }
      };
      await storageScope(db, (sql) => Effect.promise(() => exercise(sql)));
    } finally {
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  120_000,
);
