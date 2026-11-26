import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import {
  DEV_SSH_OWNER_GUARDED_APPROVAL,
  DEV_SSH_OWNER_GUARDED_MARKER,
  DEV_SSH_OWNER_PROFILE_PREFIX,
  supportsDevSshOwnerGuardedFixture,
} from "@bigbud/shared/DevLauncher";
import { Effect, Layer, Schema } from "effect";
import { expect, it, vi } from "vitest";

import { makeRoutesLayer } from "../server.routes.ts";
import { buildAppUnderTest } from "../server.test.app.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { getWsServerUrl, serverTestLayer, withWsRpcClient } from "../server.test.rpc.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.fixture.ts";
import { DevSshOwnerRuntime, makeDevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import { pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";

const supported = await supportsDevSshOwnerGuardedFixture();

it.skipIf(!supported || !pickerProofOptedIn)(
  "creates exclusively over authenticated selected Files RPC and live SSH",
  async () => {
    const profile = await mkdtemp(`/tmp/${DEV_SSH_OWNER_PROFILE_PREFIX}`);
    try {
      vi.stubEnv("BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE", profile);
      vi.stubEnv(
        "BIGBUD_SSH_OWNER_BIN",
        process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
          fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
      await writeFile(
        path.join(profile, DEV_SSH_OWNER_GUARDED_MARKER),
        DEV_SSH_OWNER_GUARDED_APPROVAL,
        {
          mode: 0o600,
          flag: "wx",
        },
      );
      activateDevSshOwner();
      await storageScope(path.join(profile, "state.sqlite"), () =>
        Effect.gen(function* () {
          const session = yield* makeDevSshOwnerRuntime();
          if (session?.kind !== "unix" || !("guardedWorkspace" in session))
            throw new Error("Expected the disposable selected Files profile");
          const authToken = randomUUID();
          yield* buildAppUnderTest({
            config: { authToken },
            routes: makeRoutesLayer.pipe(
              Layer.provide(Layer.succeed(DevSshOwnerRuntime, { session })),
            ),
          });
          const endpoint = `${yield* getWsServerUrl("/ws")}?token=${authToken}`;
          const input = { executionTargetId: session.targetId, cwd: session.fixture.folder };
          const wrong = { ...input, cwd: path.join(input.cwd, "nested") };
          const write = {
            ...input,
            relativePath: "nested/new.txt",
            contents: "",
            createOnly: true,
          };
          yield* Effect.promise(async () => {
            await mkdir(wrong.cwd);
            await writeFile(path.join(wrong.cwd, "original.txt"), "unchanged");
            await symlink("original.txt", path.join(wrong.cwd, "link.txt"));
          });
          yield* withWsRpcClient(endpoint, (client) =>
            Effect.gen(function* () {
              const before = yield* client[WS_METHODS.projectsEntryActions](input);
              expect(before.createFile.allowed).toBe(false);
              expect(yield* Effect.flip(client[WS_METHODS.projectsWriteFile](write))).toMatchObject(
                {
                  writeDisposition: "not-dispatched",
                },
              );
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
              expect(yield* client[WS_METHODS.projectsEntryActions](input)).toEqual({
                ...before,
                createFile: { allowed: true },
              });
              expect(
                (yield* client[WS_METHODS.projectsEntryActions](wrong)).createFile.allowed,
              ).toBe(false);
              expect(
                yield* Effect.flip(client[WS_METHODS.projectsWriteFile]({ ...write, ...wrong })),
              ).toMatchObject({
                writeDisposition: "not-dispatched",
              });
              expect(yield* client[WS_METHODS.projectsWriteFile](write)).toEqual({
                relativePath: write.relativePath,
              });
              for (const relativePath of [write.relativePath, "nested/link.txt"]) {
                expect(
                  yield* Effect.flip(
                    client[WS_METHODS.projectsWriteFile]({
                      ...write,
                      relativePath,
                      contents: "replace",
                    }),
                  ),
                ).toMatchObject({
                  alreadyExists: true,
                  writeDisposition: "terminal",
                });
              }
              yield* client[WS_METHODS.serverDisconnectExecutionTarget]({
                executionTargetId: input.executionTargetId,
              });
              expect(
                yield* Effect.flip(
                  client[WS_METHODS.projectsWriteFile]({
                    ...write,
                    relativePath: "nested/disconnected.txt",
                  }),
                ),
              ).toMatchObject({
                writeDisposition: "not-dispatched",
              });
            }),
          );
          expect(
            yield* Effect.promise(() => readFile(path.join(input.cwd, write.relativePath), "utf8")),
          ).toBe("");
          expect(
            yield* Effect.promise(() => readFile(path.join(wrong.cwd, "original.txt"), "utf8")),
          ).toBe("unchanged");
          expect(yield* Effect.promise(() => readdir(wrong.cwd))).toEqual([
            "link.txt",
            "new.txt",
            "original.txt",
          ]);
        }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverTestLayer, serverHttpTestLayer))),
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(profile, { recursive: true, force: true });
    }
  },
  90_000,
);
