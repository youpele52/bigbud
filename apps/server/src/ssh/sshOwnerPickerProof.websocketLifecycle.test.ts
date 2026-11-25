import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { release } from "node:os";
import path from "node:path";

import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import { Effect, Layer, Option, Schema } from "effect";
import { expect, it, vi } from "vitest";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { makeRoutesLayer } from "../server.routes.ts";
import { buildAppUnderTest } from "../server.test.app.ts";
import { defaultProjectId } from "../server.test.fixtures.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { attemptRawUpgrade } from "../server.test.remote.ts";
import {
  getWsServerUrl,
  serverTestLayer,
  withWsRpcClient,
  type WsRpcClient,
} from "../server.test.rpc.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.fixture.ts";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { DevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";
import { REMOTE_TARGET_DISCONNECTED_MESSAGE } from "./sshTargetDisconnects.ts";
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";

const decodeChallenge = Schema.decodeUnknownSync(SshHostTrustChallenge);

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "runs the selected authenticated picker from first-use trust through transport loss and durable Disconnect",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ boundIdleMasterLifetime: true });
    try {
      const launch = await proofOptions(fixture, undefined, false, true);
      const profile = "picker-lifecycle.sqlite";
      const db = path.join(fixture.root, profile);
      const targetId = fixture.executionTargetId;
      const target = { executionTargetId: targetId };
      const remote = { ...target, path: `~/${path.basename(fixture.folder)}` };
      const expectedListing = {
        path: fixture.folder,
        homePath: fixture.home,
        folders: [
          { name: "alpha", isGitRepo: false },
          { name: "Z repo", isGitRepo: true },
        ],
        truncated: false,
      };
      const [keyType, key] = fixture.hostPublicKey.split(" ");
      if (keyType !== "ssh-ed25519" || !key) throw new Error("Missing disposable Ed25519 host key");
      const fingerprint = `SHA256:${createHash("sha256").update(Buffer.from(key, "base64")).digest("base64").replace(/=+$/, "")}`;
      const exactPin = `${fixture.host} ${fixture.hostPublicKey}\n`;
      const trustBytes = () => readFile(fixture.knownHosts, "utf8");
      const epochs: Uint8Array[] = [];
      const masterLeases = async () =>
        (await readdir(fixture.root)).filter((entry) => /^bbcm-[A-Za-z0-9]{12}$/.test(entry));
      const counters = async () => ({
        // sshd counters are per listener lifetime (reset on fixture.start()).
        connections: fixture.connectionStarts(),
        authentications: fixture.acceptedPublicKeys(),
        legacyChildren: (await fixture.launchNames()).length,
        nativeMasterLeases: (await masterLeases()).length,
        ownerStarts: epochs.length,
      });
      type Counters = Awaited<ReturnType<typeof counters>>;
      const observations: Record<string, Counters> = {};
      const observe = async (phase: string) => (observations[phase] = await counters());
      const project = {
        projectId: defaultProjectId,
        title: "Disposable picker workspace",
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: targetId,
        executionTargetId: targetId,
        workspaceRoot: fixture.folder,
        defaultModelSelection: null,
        scripts: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        deletingAt: null,
        deletedAt: null,
      };
      // Only the saved-workspace lookup is seeded. The monitor handlers and client admission
      // remain real, so a missing repository/project cannot make the negative probe pass.
      const projects = Layer.mock(ProjectionProjectRepository)({
        getById: ({ projectId }) =>
          Effect.succeed(projectId === project.projectId ? Option.some(project) : Option.none()),
        listAll: () => Effect.succeed([project]),
      });
      const withProfile = <A, E>(run: (client: WsRpcClient) => Effect.Effect<A, E>) =>
        storageScope(db, (sql) =>
          Effect.gen(function* () {
            const picker = yield* Effect.acquireRelease(
              Effect.sync(() =>
                makeSshOwnerDevPicker({
                  executionTargetId: targetId,
                  host: fixture.host,
                  startOwner: async (profileBinding) => {
                    const owner = await startPickerProofOwner({
                      ...launch,
                      profileBinding,
                      posixPickerMaster: true,
                      sql,
                    });
                    epochs.push(owner.ownerEpoch);
                    return owner;
                  },
                }),
              ),
              (picker) => Effect.promise(picker.close),
            );
            const runtime = Layer.succeed(DevSshOwnerRuntime, {
              session: {
                kind: "unix",
                alias: "proof-lifecycle",
                targetId,
                fixture,
                picker,
                sql,
                terminal: undefined,
              },
            });
            const authToken = randomUUID();
            yield* buildAppUnderTest({
              config: { authToken },
              routes: makeRoutesLayer.pipe(Layer.provide(Layer.merge(runtime, projects))),
            });
            const wsUrl = yield* getWsServerUrl("/ws");
            expect(yield* Effect.promise(() => attemptRawUpgrade(wsUrl))).toMatchObject({
              upgraded: false,
              status: 401,
            });
            yield* withWsRpcClient(`${wsUrl}?token=${authToken}`, run).pipe(
              Effect.timeout("30 seconds"),
            );
          }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverTestLayer, serverHttpTestLayer))),
        );
      const read = (client: WsRpcClient) => client[WS_METHODS.serverListRemoteFolders](remote);
      const disconnects = (client: WsRpcClient) =>
        client[WS_METHODS.serverListDisconnectedExecutionTargets]({});
      const expectBlocked = (client: WsRpcClient) =>
        Effect.gen(function* () {
          expect(yield* disconnects(client)).toEqual({ executionTargetIds: [targetId] });
          expect(yield* read(client).pipe(Effect.flip)).toMatchObject({
            _tag: "ServerListRemoteFoldersError",
            message: REMOTE_TARGET_DISCONNECTED_MESSAGE,
          });
          expect(yield* client[WS_METHODS.serverListConnectedSshMonitors]({})).toEqual([]);
          expect(
            yield* client[WS_METHODS.serverSampleSshMonitor]({ projectId: defaultProjectId }).pipe(
              Effect.flip,
            ),
          ).toBe("SSH monitor requires a connected saved workspace");
        });

      vi.stubEnv("PATH", fixture.env.PATH);
      vi.stubEnv("HOME", fixture.home);
      activateDevSshOwner();
      expect(fixture.port).not.toBe(22);
      await fixture.start();
      await withProfile((client) =>
        Effect.gen(function* () {
          expect(yield* Effect.promise(trustBytes)).toBe("");
          const unknown = yield* read(client).pipe(Effect.flip);
          expect(unknown._tag).toBe("ServerListRemoteFoldersError");
          expect(unknown.message.startsWith(SSH_HOST_TRUST_REQUIRED_PREFIX)).toBe(true);
          const challenge = decodeChallenge(
            JSON.parse(unknown.message.slice(SSH_HOST_TRUST_REQUIRED_PREFIX.length)),
          );
          expect(challenge).toEqual({
            challengeId: expect.stringMatching(/^rust-dev:[\w-]{43}$/),
            host: fixture.host,
            keyType,
            fingerprint,
          });
          const untrusted = yield* Effect.promise(() => observe("unknownHost"));
          expect(untrusted.connections).toBeGreaterThan(0);
          expect(untrusted.authentications).toBe(0);
          expect(untrusted.nativeMasterLeases).toBe(0);
          expect(yield* Effect.promise(trustBytes)).toBe("");
          expect(
            yield* client[WS_METHODS.serverTrustSshHost]({
              ...target,
              challengeId: challenge.challengeId,
            }),
          ).toEqual({ message: "SSH host trusted." });
          expect(yield* Effect.promise(trustBytes)).toBe(exactPin);
          const approved = yield* Effect.promise(() => observe("approved"));
          expect(approved.authentications).toBe(0);

          expect(yield* Effect.all([read(client), read(client)], { concurrency: 2 })).toEqual([
            expectedListing,
            expectedListing,
          ]);
          const first = yield* Effect.promise(() => observe("firstRead"));
          expect(first).toEqual({
            connections: approved.connections + 1,
            authentications: 1,
            nativeMasterLeases: 1,
            legacyChildren: 0,
            ownerStarts: 1,
          });
          const [lease] = yield* Effect.promise(masterLeases);
          if (!lease) throw new Error("Expected a live native master socket");
          const socket = path.join(fixture.root, lease, "s");
          expect((yield* Effect.promise(() => lstat(socket))).isSocket()).toBe(true);

          // Stop accepting connections on the exact fixture port. Stock sshd expires its existing
          // idle child independently. Neither the owner nor the authenticated WebSocket is stopped.
          yield* Effect.promise(fixture.stop);
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" }), {
              timeout: 12_000,
            }),
          );
          expect(yield* read(client).pipe(Effect.flip)).toMatchObject({
            _tag: "ServerListRemoteFoldersError",
            code: "sshTransportLost",
            message:
              "The SSH connection failed. Check that the configured host and port are reachable.",
          });
          expect(yield* Effect.promise(() => observe("transportLost"))).toEqual({
            ...first,
            nativeMasterLeases: 0,
          });
          yield* Effect.promise(() => fixture.start());
          // Exceed the first 250ms retry admission bound; this is a new RPC, not replay.
          yield* Effect.sleep("300 millis");
          expect(yield* Effect.promise(() => observe("beforeRecoveryRead"))).toEqual({
            connections: 0,
            authentications: 0,
            nativeMasterLeases: 0,
            legacyChildren: 0,
            ownerStarts: 1,
          });
          expect(yield* read(client)).toEqual(expectedListing);
          const recovered = yield* Effect.promise(() => observe("recovered"));
          expect(recovered).toEqual({
            connections: 1,
            authentications: 1,
            nativeMasterLeases: 1,
            legacyChildren: 0,
            ownerStarts: 1,
          });
          expect(yield* Effect.promise(masterLeases)).not.toContain(lease);

          expect(yield* client[WS_METHODS.serverDisconnectExecutionTarget](target)).toEqual({
            ...target,
            disconnected: true,
          });
          yield* expectBlocked(client);
          expect(yield* Effect.promise(() => observe("disconnected"))).toEqual({
            ...recovered,
            nativeMasterLeases: 0,
          });
        }),
      );

      // Native owner exits and a fresh owner hydrates the re-opened SQLite profile. The HTTP/WS
      // scope is recreated as well, but the test is not claiming a backend executable restart.
      const disconnected = await observe("betweenScopes");
      expect(disconnected).toEqual(observations.disconnected);
      await withProfile((client) =>
        Effect.gen(function* () {
          yield* expectBlocked(client);
          expect(epochs).toHaveLength(2);
          expect(epochs[1]).not.toEqual(epochs[0]);
          // Leave a full monitor freshness window with a reachable listener, then exercise the
          // same read and monitor routes again. No positive result is treated as a DNS audit.
          yield* Effect.sleep("5100 millis");
          yield* expectBlocked(client);
          const blocked = yield* Effect.promise(() => observe("restartedWhileDisconnected"));
          expect(blocked).toEqual({ ...disconnected, ownerStarts: 2 });
          expect(yield* client[WS_METHODS.serverConnectExecutionTarget](target)).toEqual({
            ...target,
            disconnected: false,
          });
          expect(yield* disconnects(client)).toEqual({ executionTargetIds: [] });
          expect(yield* Effect.promise(() => observe("explicitConnect"))).toEqual(blocked);
          expect(yield* read(client)).toEqual(expectedListing);
          expect(yield* Effect.promise(() => observe("readAfterConnect"))).toEqual({
            ...blocked,
            connections: blocked.connections + 1,
            authentications: blocked.authentications + 1,
            nativeMasterLeases: 1,
          });
          expect(yield* Effect.promise(trustBytes)).toBe(exactPin);
        }),
      );
      console.info("S1 selected picker WebSocket lifecycle", {
        platform: `${process.platform}/${process.arch} (${release()})`,
        profile,
        debugOwnerSha256: createHash("sha256")
          .update(await readFile(path.join(fixture.root, "picker-owner")))
          .digest("hex"),
        ssh: fixture.ssh,
        sshd: fixture.sshd,
        versions: fixture.versions,
        restart: "native owner, SQLite reopen and in-process HTTP/WS scope recreation",
        transport: "IPv4 literal, non-default port; no DNS instrumentation",
        counters: observations,
      });
    } finally {
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  75_000,
);
