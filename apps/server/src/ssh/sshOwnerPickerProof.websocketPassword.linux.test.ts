import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";

import { makeRoutesLayer } from "../server.routes.ts";
import { buildAppUnderTest } from "../server.test.app.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { getWsServerUrl, serverTestLayer, withWsRpcClient } from "../server.test.rpc.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.ts";
import { makeSshOwnerDevPicker, SYNTHETIC_SSH_UNLOCK_INTENT } from "./sshOwnerDevPicker.ts";
import { DevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import {
  startPickerProofOwner,
  type LaunchedPickerProofOwner,
} from "./sshOwnerPickerProof.client.ts";
import { pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { prepareProofOwner } from "./sshOwnerPickerProof.posixPassword.fixture.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

it
  .skipIf(process.platform !== "linux" || !pickerProofOptedIn)
  .each(["disabled", "synthetic"] as const)(
  "guards password submission through authenticated application routes (%s)",
  async (mode) => {
    const fixture = await makeLinuxLoopbackPickerFixture({ syntheticPassword: true });
    try {
      await writeFile(fixture.knownHosts, `${fixture.host} ${await fixture.getHostPublicKey()}\n`, {
        mode: 0o600,
      });
      const { options, targetId } = await prepareProofOwner(fixture);
      const authToken = randomUUID();
      activateDevSshOwner();
      await storageScope(path.join(fixture.root, "app-password.sqlite"), (sql) =>
        Effect.gen(function* () {
          const startOwner = vi.fn((profileBinding: Uint8Array) =>
            startPickerProofOwner({ ...options, sql, profileBinding }),
          );
          const picker = yield* Effect.acquireRelease(
            Effect.sync(() =>
              makeSshOwnerDevPicker<LaunchedPickerProofOwner>({
                executionTargetId: targetId,
                host: fixture.host,
                startOwner,
                ...(mode === "synthetic"
                  ? {
                      unlockSyntheticPasswordFixture: (owner) =>
                        owner.unlockSyntheticPosixPassword(),
                    }
                  : {}),
              }),
            ),
            (value) => Effect.promise(value.close),
          );
          const runtime = Layer.succeed(DevSshOwnerRuntime, {
            session: {
              kind: "unix",
              alias: "proof-app-password",
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
          const url = yield* getWsServerUrl("/ws");
          yield* withWsRpcClient(`${url}?token=${authToken}`, (client) =>
            Effect.gen(function* () {
              const deliberatelyRejected = "discarded-credential-looking-fixture-value";
              const fail = yield* client[WS_METHODS.serverUnlockSshPassword]({
                executionTargetId: targetId,
                password: deliberatelyRejected,
              }).pipe(Effect.flip);
              expect(fail).toMatchObject({ _tag: "ServerUnlockSshPasswordError" });
              expect(JSON.stringify(fail)).not.toContain(deliberatelyRejected);
              expect(
                yield* client[WS_METHODS.serverUnlockSshKey]({
                  executionTargetId: targetId,
                  passphrase: deliberatelyRejected,
                }).pipe(Effect.flip),
              ).toMatchObject({ _tag: "ServerUnlockSshKeyError" });

              const unlock = (executionTargetId: string) =>
                client[WS_METHODS.serverUnlockSshPassword]({
                  executionTargetId,
                  password: SYNTHETIC_SSH_UNLOCK_INTENT,
                });
              expect(
                yield* unlock("ssh:unconfigured-disposable-target").pipe(Effect.flip),
              ).toMatchObject({ _tag: "ServerUnlockSshPasswordError" });
              expect(startOwner).not.toHaveBeenCalled();
              expect(yield* Effect.promise(fixture.readPasswordDaemonLog)).not.toMatch(
                /^Connection from /m,
              );
              if (mode === "disabled") {
                expect(yield* unlock(targetId).pipe(Effect.flip)).toMatchObject({
                  _tag: "ServerUnlockSshPasswordError",
                });
                expect(startOwner).not.toHaveBeenCalled();
                expect(yield* Effect.promise(fixture.readPasswordDaemonLog)).not.toMatch(
                  /^Connection from /m,
                );
                return;
              }

              expect(yield* unlock(targetId)).toEqual({
                message: "Disposable SSH fixture unlocked.",
              });
              expect(
                yield* client[WS_METHODS.serverListRemoteFolders]({
                  executionTargetId: targetId,
                  path: fixture.folder,
                }),
              ).toMatchObject({
                path: fixture.folder,
                folders: [{ name: "alpha" }, { name: "Z repo" }],
              });
              expect(startOwner).toHaveBeenCalledTimes(1);
              const log = yield* Effect.promise(fixture.readPasswordDaemonLog);
              expect(log.match(/^Connection from /gm)).toHaveLength(1);
              expect(log.match(/^Accepted password for picker /gm)).toHaveLength(1);
              expect(log).not.toMatch(/^Accepted (?!password )/m);
              expect(
                yield* client[WS_METHODS.serverDisconnectExecutionTarget]({
                  executionTargetId: targetId,
                }),
              ).toMatchObject({ disconnected: true });
              expect(yield* unlock(targetId).pipe(Effect.flip)).toMatchObject({
                _tag: "ServerUnlockSshPasswordError",
              });
              expect(
                (yield* Effect.promise(fixture.readPasswordDaemonLog)).match(/^Connection from /gm),
              ).toHaveLength(1);
            }).pipe(Effect.timeout("25 seconds")),
          );
        }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverTestLayer, serverHttpTestLayer))),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);
