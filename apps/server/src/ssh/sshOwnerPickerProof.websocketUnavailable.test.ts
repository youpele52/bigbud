import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";

import { makeRoutesLayer } from "../server.routes.ts";
import { buildAppUnderTest } from "../server.test.app.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { attemptRawUpgrade } from "../server.test.remote.ts";
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

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn).each([
  ["incompatible owner", "versionIncompatible"],
  ["missing owner", "ownerUnavailable"],
] as const)(
  "keeps the local WebSocket RPC live when the %s cannot start",
  async (mode, nativeError) => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const launch = await proofOptions(fixture);
      const authToken = randomUUID();
      const targetId = fixture.executionTargetId;
      const remote = { executionTargetId: targetId, path: fixture.folder };
      const localName = "local-rpc-fresh.txt";
      const localFile = path.join(fixture.root, localName);
      await writeFile(localFile, "local before owner failure\n", { mode: 0o600 });
      vi.stubEnv("PATH", fixture.env.PATH);
      vi.stubEnv("HOME", fixture.home);
      activateDevSshOwner();
      await fixture.start();
      await storageScope(path.join(fixture.root, "owner-unavailable.sqlite"), (sql) =>
        Effect.gen(function* () {
          const failures: unknown[] = [];
          const startOwner = vi.fn(async (profileBinding: Uint8Array) => {
            try {
              return await startPickerProofOwner({
                ...launch,
                profileBinding,
                targetId,
                sql,
                ...(mode === "incompatible owner"
                  ? { major: 99 }
                  : { binary: path.join(fixture.root, "missing-owner") }),
              });
            } catch (error) {
              failures.push(error);
              throw error;
            }
          });
          const picker = yield* Effect.acquireRelease(
            Effect.sync(() =>
              makeSshOwnerDevPicker({
                executionTargetId: targetId,
                host: fixture.host,
                startOwner,
              }),
            ),
            (picker) => Effect.promise(picker.close),
          );
          const runtime = Layer.succeed(DevSshOwnerRuntime, {
            session: {
              kind: "unix",
              alias: "proof-unavailable",
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
          const wsUrl = yield* getWsServerUrl("/ws");
          expect(yield* Effect.promise(() => attemptRawUpgrade(wsUrl))).toMatchObject({
            upgraded: false,
            status: 401,
          });
          expect(startOwner).not.toHaveBeenCalled();
          const attempts = fixture.connectionStarts();
          yield* withWsRpcClient(`${wsUrl}?token=${authToken}`, (client) =>
            Effect.gen(function* () {
              const local = () =>
                client[WS_METHODS.projectsReadFilePreview]({
                  cwd: fixture.root,
                  relativePath: localName,
                });
              expect(yield* local()).toMatchObject({ contents: "local before owner failure\n" });
              expect(startOwner).not.toHaveBeenCalled();
              for (const _ of [1, 2]) {
                const result = yield* client[WS_METHODS.serverListRemoteFolders](remote).pipe(
                  Effect.flip,
                );
                expect(result).toMatchObject({
                  _tag: "ServerListRemoteFoldersError",
                  code: "sshOwnerUnavailable",
                });
              }
              expect(startOwner).toHaveBeenCalledTimes(1);
              expect(failures).toMatchObject([{ code: nativeError }]);
              yield* Effect.promise(() => writeFile(localFile, "local after owner failure\n"));
              expect(yield* local()).toMatchObject({ contents: "local after owner failure\n" });
              expect(fixture.connectionStarts()).toBe(attempts);
              expect(fixture.acceptedPublicKeys()).toBe(0);
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
