import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import { DEV_SSH_OWNER_PROFILE_PREFIX } from "@bigbud/shared/DevLauncher";
import { Effect, Exit, Layer, Schema } from "effect";
import { expect, it, vi } from "vitest";

import { makeRoutesLayer } from "../server.routes.ts";
import { buildAppUnderTest } from "../server.test.app.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { getWsServerUrl, serverTestLayer, withWsRpcClient } from "../server.test.rpc.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.fixture.ts";
import { DevSshOwnerRuntime, makeDevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import { pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";

const supported = process.platform === "darwin" || process.platform === "linux";

it.skipIf(!supported || !pickerProofOptedIn)(
  "creates and deletes folders over the authenticated selected Files RPC",
  async () => {
    const profile = await mkdtemp(`/tmp/${DEV_SSH_OWNER_PROFILE_PREFIX}`);
    try {
      vi.stubEnv("BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE", profile);
      vi.stubEnv(
        "BIGBUD_SSH_OWNER_BIN",
        process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
          fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
      activateDevSshOwner();
      await storageScope(path.join(profile, "state.sqlite"), () =>
        Effect.gen(function* () {
          const session = yield* makeDevSshOwnerRuntime();
          if (session?.kind !== "unix") throw new Error("Expected the disposable selected profile");
          const authToken = randomUUID();
          yield* buildAppUnderTest({
            config: { authToken },
            routes: makeRoutesLayer.pipe(
              Layer.provide(Layer.succeed(DevSshOwnerRuntime, { session })),
            ),
          });
          const endpoint = `${yield* getWsServerUrl("/ws")}?token=${authToken}`;
          const input = { executionTargetId: session.targetId, cwd: session.fixture.folder };
          const outside = path.join(session.fixture.home, "outside-folder");
          yield* Effect.promise(async () => {
            await mkdir(outside, { recursive: true });
            await symlink(outside, path.join(input.cwd, "escape"));
            await writeFile(path.join(input.cwd, "delete-me.txt"), "keep?");
          });
          yield* withWsRpcClient(endpoint, (client) =>
            Effect.gen(function* () {
              const trustInput = { executionTargetId: input.executionTargetId, path: input.cwd };
              const challenge = yield* Effect.flip(
                client[WS_METHODS.serverListRemoteFolders](trustInput),
              );
              expect(challenge.message.startsWith(SSH_HOST_TRUST_REQUIRED_PREFIX)).toBe(true);
              const { challengeId } = Schema.decodeUnknownSync(SshHostTrustChallenge)(
                JSON.parse(challenge.message.slice(SSH_HOST_TRUST_REQUIRED_PREFIX.length)),
              );
              yield* client[WS_METHODS.serverTrustSshHost]({ ...trustInput, challengeId });
              yield* client[WS_METHODS.projectsListDirectory](input);
              const actions = yield* client[WS_METHODS.projectsEntryActions](input);
              expect(actions.createFolder.allowed).toBe(true);
              expect(actions.delete).toMatchObject({ allowed: true, permanent: true });

              const create = (relativePath: string) =>
                client[WS_METHODS.projectsCreateDirectory]({ ...input, relativePath });
              yield* create("created");
              expect(yield* Effect.promise(() => readdir(path.join(input.cwd, "created")))).toEqual(
                [],
              );
              expect(yield* Effect.flip(create("created"))).toMatchObject({ alreadyExists: true });
              // NUL never reaches the wire: the contract schema refuses it at the client encoder.
              expect(Exit.isFailure(yield* Effect.exit(create(`bad\0name`)))).toBe(true);
              for (const bad of ["../escape", "escape/child", "/absolute"]) {
                expect(yield* Effect.flip(create(bad))).toMatchObject({
                  mutationDisposition: "not-dispatched",
                });
              }
              expect(yield* Effect.promise(() => readdir(outside))).toEqual([]);

              const del = (relativePath: string, expectedKind: "file" | "directory") =>
                client[WS_METHODS.projectsDeleteEntry]({ ...input, relativePath, expectedKind });
              yield* Effect.promise(() => writeFile(path.join(input.cwd, "created", "child"), "x"));
              expect(yield* del("created", "directory")).toMatchObject({
                relativePath: "created",
                disposition: "deleted",
              });
              expect(yield* del("delete-me.txt", "file")).toMatchObject({
                relativePath: "delete-me.txt",
                disposition: "deleted",
              });
              expect(yield* Effect.flip(del("delete-me.txt", "file"))).toMatchObject({
                notFound: true,
              });
              expect(yield* Effect.flip(del("escape", "directory"))).toMatchObject({
                mutationDisposition: "not-dispatched",
              });
              expect(yield* Effect.promise(() => readdir(outside))).toEqual([]);

              yield* client[WS_METHODS.serverDisconnectExecutionTarget]({
                executionTargetId: input.executionTargetId,
              });
              for (const attempt of [create("after"), del("delete-me.txt", "file")]) {
                expect(yield* Effect.flip(attempt)).toMatchObject({
                  mutationDisposition: "not-dispatched",
                });
              }
            }),
          );
          expect(yield* Effect.promise(() => readdir(input.cwd))).toEqual(
            expect.arrayContaining(["escape"]),
          );
        }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverTestLayer, serverHttpTestLayer))),
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(profile, { recursive: true, force: true });
    }
  },
  90_000,
);
