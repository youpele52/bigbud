import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { expect, it, vi } from "vitest";

import { makeRoutesLayer } from "../server.routes.ts";
import { buildAppUnderTest } from "../server.test.app.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { getWsServerUrl, serverTestLayer, withWsRpcClient } from "../server.test.rpc.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.ts";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { DevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "delivers native workspace invalidations over WebSocket after a different subscriber cancels",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      const targetId = options.targetId;
      const target = { executionTargetId: targetId };
      const authToken = randomUUID();
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      vi.stubEnv("HOME", fixture.home);
      vi.stubEnv("PATH", fixture.env.PATH);
      activateDevSshOwner();
      await storageScope(path.join(fixture.root, "watch-ws.sqlite"), (sql) =>
        Effect.gen(function* () {
          const startOwner = vi.fn((profileBinding: Uint8Array) =>
            startPickerProofOwner({
              ...options,
              profileBinding,
              sql,
              workspaceRoot: fixture.folder,
            }),
          );
          const picker = yield* Effect.acquireRelease(
            Effect.sync(() =>
              makeSshOwnerDevPicker({
                executionTargetId: targetId,
                host: fixture.host,
                startOwner,
              }),
            ),
            (value) => Effect.promise(value.close),
          );
          const runtime = Layer.succeed(DevSshOwnerRuntime, {
            session: {
              kind: "unix",
              alias: "proof-ws-watch",
              targetId,
              fixture,
              picker,
              sql,
              terminal: undefined,
            },
          });
          yield* buildAppUnderTest({
            config: { authToken },
            routes: makeRoutesLayer.pipe(Layer.provide(runtime)),
          });
          const endpoint = `${yield* getWsServerUrl("/ws")}?token=${authToken}`;
          const input = { ...target, cwd: fixture.folder };
          const waiting = yield* Deferred.make<void>();
          const keeperReady = yield* Deferred.make<void>();
          const cancelled = yield* Effect.forkScoped(
            withWsRpcClient(endpoint, (client) =>
              client[WS_METHODS.subscribeProjectDirectoryChanges](input).pipe(
                Stream.tap(() => Deferred.succeed(waiting, undefined)),
                Stream.runDrain,
              ),
            ),
          );
          yield* withWsRpcClient(endpoint, (client) =>
            Effect.gen(function* () {
              let disconnectedDialCount = 0;
              const kept = yield* Effect.forkScoped(
                client[WS_METHODS.subscribeProjectDirectoryChanges](input).pipe(
                  Stream.tap((event) =>
                    event.generation === 1 ? Deferred.succeed(keeperReady, undefined) : Effect.void,
                  ),
                  Stream.tap((event) =>
                    Effect.gen(function* () {
                      if (event.generation === 2) {
                        yield* client[WS_METHODS.serverDisconnectExecutionTarget](target);
                        disconnectedDialCount = fixture.connectionStarts();
                      } else if (event.type === "rescanRequired") {
                        expect(fixture.connectionStarts()).toBe(disconnectedDialCount);
                        yield* client[WS_METHODS.serverConnectExecutionTarget](target);
                        expect(fixture.connectionStarts()).toBe(disconnectedDialCount);
                      }
                    }),
                  ),
                  Stream.take(4),
                  Stream.runCollect,
                ),
              );
              yield* Deferred.await(waiting);
              yield* Deferred.await(keeperReady);
              yield* Fiber.interrupt(cancelled);
              const write = { ...input, relativePath: "watch-ws.txt", contents: "changed" };
              expect(yield* client[WS_METHODS.projectsWriteFile](write)).toEqual({
                relativePath: "watch-ws.txt",
              });
              expect(
                yield* Effect.promise(() =>
                  readFile(path.join(fixture.folder, write.relativePath), "utf8"),
                ),
              ).toBe(write.contents);
              const events = yield* Fiber.join(kept);
              expect(events.map(({ type, generation }) => [type, generation])).toEqual([
                ["directoryChanged", 1],
                ["directoryChanged", 2],
                ["rescanRequired", 3],
                ["directoryChanged", 4],
              ]);
              expect(fixture.connectionStarts()).toBeGreaterThan(disconnectedDialCount);
              expect(
                yield* client[WS_METHODS.projectsSearchEntries]({
                  ...input,
                  query: "watch-ws",
                  limit: 10,
                }),
              ).toMatchObject({
                entries: [{ path: "watch-ws.txt", kind: "file" }],
                truncated: false,
              });
              expect(
                yield* client[WS_METHODS.projectsSearchFileContents]({
                  ...input,
                  query: "changed",
                  limit: 10,
                }),
              ).toMatchObject({
                matches: [{ path: "watch-ws.txt", line: 1, column: 1, lineText: "changed" }],
                truncated: false,
              });
              yield* client[WS_METHODS.serverDisconnectExecutionTarget](target);
              const beforeDeniedSearch = fixture.connectionStarts();
              expect(
                yield* client[WS_METHODS.projectsSearchEntries]({
                  ...input,
                  query: "watch-ws",
                  limit: 10,
                }).pipe(Effect.flip),
              ).toMatchObject({
                message: expect.stringMatching(/disconnected/i),
              });
              expect(
                yield* client[WS_METHODS.projectsWriteFile]({
                  ...write,
                  contents: "must not write",
                }).pipe(Effect.flip),
              ).toMatchObject({
                writeDisposition: "not-dispatched",
              });
              expect(
                yield* Effect.promise(() =>
                  readFile(path.join(fixture.folder, write.relativePath), "utf8"),
                ),
              ).toBe(write.contents);
              expect(fixture.connectionStarts()).toBe(beforeDeniedSearch);
            }).pipe(Effect.scoped, Effect.timeout("25 seconds")),
          );
          expect(startOwner).toHaveBeenCalledTimes(1);
          expect(yield* Effect.promise(fixture.launchNames)).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverTestLayer, serverHttpTestLayer))),
      );
    } finally {
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  60_000,
);
