import { randomUUID } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";

import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { Effect, Fiber, Layer } from "effect";
import { expect, it, vi } from "vitest";

import { makeRoutesLayer } from "../server.routes.ts";
import { buildAppUnderTest } from "../server.test.app.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { getWsServerUrl, serverTestLayer, withWsRpcClient } from "../server.test.rpc.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.ts";
import { DevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { PickerProofOwnerError, startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "propagates authenticated WebSocket cancellation to the running owner and drops a cancelled queued read",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ pauseFirstPickerCommand: true });
    try {
      const options = await proofOptions(fixture);
      const targetId = fixture.executionTargetId;
      const input = { executionTargetId: targetId, path: `~/${path.basename(fixture.folder)}` };
      const authToken = randomUUID();
      const nativeCancelled = Promise.withResolvers<void>();
      vi.stubEnv("PATH", fixture.env.PATH);
      vi.stubEnv("HOME", fixture.home);
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      activateDevSshOwner();
      await fixture.start();
      await storageScope(path.join(fixture.root, "picker-websocket-cancel.sqlite"), (sql) =>
        Effect.gen(function* () {
          const picker = yield* Effect.acquireRelease(
            Effect.sync(() =>
              makeSshOwnerDevPicker({
                executionTargetId: targetId,
                host: fixture.loopback,
                startOwner: (profileBinding) =>
                  startPickerProofOwner({
                    ...options,
                    sql,
                    profileBinding,
                    posixPickerCancellation: true,
                  }),
                async listWithCancellation(owner, request, signal) {
                  try {
                    return await owner.listCancellableRemoteFolders(request, signal);
                  } catch (error) {
                    if (error instanceof PickerProofOwnerError && error.code === "listCancelled")
                      nativeCancelled.resolve();
                    throw error;
                  }
                },
              }),
            ),
            (value) => Effect.promise(() => value.close()),
          );
          const signals: Array<AbortSignal | undefined> = [];
          const runtime = Layer.succeed(DevSshOwnerRuntime, {
            session: {
              kind: "unix",
              alias: "proof-cancellation",
              targetId,
              fixture,
              picker: {
                ...picker,
                listRemoteFolders(input, signal) {
                  signals.push(signal);
                  return picker.listRemoteFolders(input, signal);
                },
              },
              sql,
              terminal: undefined,
            },
          });
          yield* buildAppUnderTest({
            config: { authToken },
            routes: makeRoutesLayer.pipe(Layer.provide(runtime)),
          });
          const url = yield* getWsServerUrl("/ws");
          yield* withWsRpcClient(`${url}?token=${authToken}`, (client) =>
            Effect.gen(function* () {
              const list = () => client[WS_METHODS.serverListRemoteFolders](input);
              const active = yield* Effect.forkChild(list());
              yield* Effect.promise(() =>
                vi.waitFor(async () => {
                  expect(
                    (await lstat(path.join(fixture.root, "held-picker-read"))).isDirectory(),
                  ).toBe(true);
                }),
              );
              const queued = yield* Effect.forkChild(list());
              yield* Effect.promise(() => vi.waitFor(() => expect(signals).toHaveLength(2)));
              yield* Fiber.interrupt(queued);
              yield* Effect.promise(() => vi.waitFor(() => expect(signals[1]?.aborted).toBe(true)));
              yield* Fiber.interrupt(active);
              yield* Effect.promise(() => nativeCancelled.promise).pipe(
                Effect.timeout("3 seconds"),
              );
              expect(fixture.connectionStarts()).toBe(1);
              yield* Effect.promise(() =>
                writeFile(path.join(fixture.root, "release-picker-read"), ""),
              );
              expect(yield* list()).toMatchObject({
                path: fixture.folder,
                folders: [{ name: "alpha" }, { name: "Z repo" }],
              });
              expect(fixture.connectionStarts()).toBe(2);
              expect(yield* Effect.promise(fixture.launchNames)).toEqual([]);
            }).pipe(Effect.timeout("20 seconds")),
          );
        }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverTestLayer, serverHttpTestLayer))),
      );
    } finally {
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  60_000,
);
