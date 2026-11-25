import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import { Effect, Layer, Schema } from "effect";
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
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";

const decodeChallenge = Schema.decodeUnknownSync(SshHostTrustChallenge);

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "approves the exact first-use key through authenticated picker RPCs without private approval or fallback",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const launch = await proofOptions(fixture);
      const authToken = randomUUID();
      const targetId = fixture.executionTargetId;
      const remote = { executionTargetId: targetId, path: `~/${path.basename(fixture.folder)}` };
      const [keyType, key] = fixture.hostPublicKey.split(" ");
      if (keyType !== "ssh-ed25519" || !key) throw new Error("Missing disposable Ed25519 host key");
      const fingerprint = `SHA256:${createHash("sha256").update(Buffer.from(key, "base64")).digest("base64").replace(/=+$/, "")}`;
      const trustBytes = () => readFile(fixture.knownHosts, "utf8");
      vi.stubEnv("PATH", fixture.env.PATH);
      vi.stubEnv("HOME", fixture.home);
      activateDevSshOwner();
      await fixture.start();
      await storageScope(path.join(fixture.root, "websocket-trust.sqlite"), (sql) =>
        Effect.gen(function* () {
          const startOwner = vi.fn((profileBinding: Uint8Array) =>
            startPickerProofOwner({ ...launch, profileBinding, targetId, sql }),
          );
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
              alias: "proof-trust-rpc",
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
          yield* withWsRpcClient(`${wsUrl}?token=${authToken}`, (client) =>
            Effect.gen(function* () {
              expect(yield* Effect.promise(trustBytes)).toBe("");
              const list = () => client[WS_METHODS.serverListRemoteFolders](remote);
              const untrusted = yield* list().pipe(Effect.flip);
              expect(untrusted).toMatchObject({
                _tag: "ServerListRemoteFoldersError",
                message: expect.stringContaining(SSH_HOST_TRUST_REQUIRED_PREFIX),
              });
              expect(untrusted.message.startsWith(SSH_HOST_TRUST_REQUIRED_PREFIX)).toBe(true);
              const challenge = decodeChallenge(
                JSON.parse(untrusted.message.slice(SSH_HOST_TRUST_REQUIRED_PREFIX.length)),
              );
              expect(challenge).toEqual({
                challengeId: expect.stringMatching(/^rust-dev:[\w-]{43}$/),
                host: fixture.host,
                keyType,
                fingerprint,
              });
              expect(fixture.connectionStarts()).toBeGreaterThan(0); // unauthenticated key observation
              expect(fixture.acceptedPublicKeys()).toBe(0);
              const beforeWrong = fixture.connectionStarts();
              const confirm = (challengeId: string, executionTargetId = targetId) =>
                client[WS_METHODS.serverTrustSshHost]({ executionTargetId, challengeId });
              expect(
                yield* confirm(challenge.challengeId, "ssh:unrelated-fixture-target").pipe(
                  Effect.flip,
                ),
              ).toMatchObject({
                _tag: "ServerTrustSshHostError",
                message: expect.stringContaining("configured fixture target"),
              });
              const wrong = `rust-dev:${randomBytes(32).toString("base64url")}`;
              expect(yield* confirm(wrong).pipe(Effect.flip)).toMatchObject({
                _tag: "ServerTrustSshHostError",
                message: "SSH host trust approval expired or is invalid. Check the host key again.",
              });
              expect(fixture.connectionStarts()).toBe(beforeWrong);
              expect(fixture.acceptedPublicKeys()).toBe(0);
              expect(yield* Effect.promise(trustBytes)).toBe("");

              expect(yield* confirm(challenge.challengeId)).toEqual({
                message: "SSH host trusted.",
              });
              const exactPin = `${fixture.host} ${fixture.hostPublicKey}\n`;
              expect(yield* Effect.promise(trustBytes)).toBe(exactPin);
              expect(fixture.acceptedPublicKeys()).toBe(0);
              const afterApproval = fixture.connectionStarts();
              expect(yield* confirm(challenge.challengeId).pipe(Effect.flip)).toMatchObject({
                _tag: "ServerTrustSshHostError",
                message: "SSH host trust approval expired or is invalid. Check the host key again.",
              });
              expect(fixture.connectionStarts()).toBe(afterApproval);
              expect(yield* list()).toEqual({
                path: fixture.folder,
                homePath: fixture.home,
                folders: [
                  { name: "alpha", isGitRepo: false },
                  { name: "Z repo", isGitRepo: true },
                ],
                truncated: false,
              });
              yield* Effect.promise(() =>
                vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1)),
              );
              expect(yield* Effect.promise(trustBytes)).toBe(exactPin);
              expect(startOwner).toHaveBeenCalledOnce();
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
