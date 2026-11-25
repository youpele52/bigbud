import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CommandId, ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
} from "@bigbud/contracts/constants/websocket.constant.ts";
import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";
import { orchestrationTestLayer } from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { makeRoutesLayer } from "../server.routes.ts";
import { buildAppUnderTest } from "../server.test.app.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { getWsServerUrl, serverTestLayer, withWsRpcClient } from "../server.test.rpc.ts";
import { toDispatchCommandError } from "../ws/wsDispatchCommandError.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.ts";
import { DEV_OWNER_SSH_CONFIG } from "./sshOwnerDevRuntime.profileConfig.ts";
import { DevSshOwnerRuntime, makeDevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import { pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "browses an existing profile alias through authenticated RPC and reopens the saved alias and folder",
  async () => {
    const root = await mkdtemp("/private/tmp/bigbud-ssh-owner-dev-");
    const alias = "laptop-workbench";
    const source = path.join(root, DEV_OWNER_SSH_CONFIG);
    const db = path.join(root, "state.sqlite");
    try {
      await writeFile(
        source,
        [
          "# Personal development hosts",
          `Host ${alias}`,
          "  Include fixture-endpoint.conf",
          "  HostKeyAlias workbench-trust",
          "  IdentitiesOnly yes",
          "Host *",
          "  ConnectTimeout 3",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      vi.stubEnv("BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE", root);
      vi.stubEnv(
        "BIGBUD_SSH_OWNER_BIN",
        process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
          fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
      activateDevSshOwner();
      await storageScope(db, (sql) =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeDevSshOwnerRuntime();
            if (session?.kind !== "unix") throw new Error("Expected the disposable Unix runtime");
            const { fixture } = session;
            if (!("connectionStarts" in fixture)) throw new Error("Expected a macOS fixture");
            const engine = yield* OrchestrationEngineService;
            const authToken = randomUUID();
            yield* buildAppUnderTest({
              config: { authToken },
              layers: {
                orchestrationEngine: engine,
                commandGateway: {
                  dispatchNormalized: ({ command }) =>
                    engine
                      .dispatch(command)
                      .pipe(
                        Effect.mapError((cause) =>
                          toDispatchCommandError(cause, "Failed to save workspace"),
                        ),
                      ),
                },
              },
              routes: makeRoutesLayer.pipe(
                Layer.provide(Layer.succeed(DevSshOwnerRuntime, { session })),
              ),
            });
            const wsUrl = `${yield* getWsServerUrl("/ws")}?token=${authToken}`;
            const projectId = ProjectId.makeUnsafe("profile-alias-workspace");
            const saved = yield* withWsRpcClient(wsUrl, (client) =>
              Effect.gen(function* () {
                const hosts = yield* client[WS_METHODS.serverListSshConfigHosts]({});
                expect(hosts.hosts).toEqual([
                  {
                    alias,
                    sourcePath: path.join(fixture.root, "owner-alias.conf"),
                    line: 2,
                    hostName: fixture.loopback,
                    user: fixture.user,
                    port: String(fixture.port),
                    hostKeyAlias: "workbench-trust",
                    route: "direct",
                    supported: true,
                  },
                ]);
                expect(fixture.connectionStarts()).toBe(0);
                const executionTargetId = `ssh:${new URLSearchParams({ host: alias, auth: "ssh-key", transport: "direct-ssh" })}`;
                expect(hosts.developmentOwnerTargetId).toBe(executionTargetId);
                const input = { executionTargetId, path: fixture.folder };
                const list = () => client[WS_METHODS.serverListRemoteFolders](input);
                const first = yield* Effect.flip(list());
                expect(first.message.startsWith(SSH_HOST_TRUST_REQUIRED_PREFIX)).toBe(true);
                expect(fixture.acceptedPublicKeys()).toBe(0);
                const { challengeId } = Schema.decodeUnknownSync(SshHostTrustChallenge)(
                  JSON.parse(first.message.slice(SSH_HOST_TRUST_REQUIRED_PREFIX.length)),
                );
                yield* client[WS_METHODS.serverTrustSshHost]({ executionTargetId, challengeId });
                const folders = yield* list();
                expect(folders.folders.map(({ name }) => name)).toEqual(["alpha", "Z repo"]);
                const { cwd } = yield* client[WS_METHODS.serverVerifyExecutionTarget]({
                  executionTargetId,
                  cwd: folders.path,
                });
                if (!cwd) throw new Error("The picker returned no verified folder");
                yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                  type: "project.create",
                  commandId: CommandId.makeUnsafe(randomUUID()),
                  projectId,
                  title: alias,
                  executionTargetId,
                  workspaceExecutionTargetId: executionTargetId,
                  providerRuntimeExecutionTargetId: "local",
                  workspaceRoot: cwd,
                  defaultModelSelection: null,
                  createdAt: new Date().toISOString(),
                });
                return { executionTargetId, cwd };
              }),
            );
            const repo = yield* ProjectionProjectRepository;
            const row = yield* repo.getById({ projectId });
            if (Option.isNone(row) || !row.value.workspaceRoot)
              throw new Error("Missing saved workspace");
            const reopened = yield* withWsRpcClient(wsUrl, (client) =>
              client[WS_METHODS.serverListRemoteFolders]({
                executionTargetId: row.value.workspaceExecutionTargetId,
                path: row.value.workspaceRoot!,
              }),
            );
            expect(row.value.workspaceExecutionTargetId).toBe(saved.executionTargetId);
            expect(reopened.path).toBe(saved.cwd);
            expect(fixture.acceptedPublicKeys()).toBeGreaterThan(0);
            const attempts = fixture.connectionStarts();
            yield* Effect.promise(() => appendFile(source, "  ProxyJump blocked\n"));
            const refusal = yield* withWsRpcClient(wsUrl, (client) =>
              Effect.flip(
                client[WS_METHODS.serverListRemoteFolders]({
                  executionTargetId: saved.executionTargetId,
                  path: saved.cwd,
                }),
              ),
            );
            expect(refusal).toMatchObject({ code: "sshConfigUnsupported" });
            expect(fixture.connectionStarts()).toBe(attempts);
            expect(yield* Effect.promise(fixture.launchNames)).toEqual([]);
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              orchestrationTestLayer(root),
              ProjectionProjectRepositoryLive,
              serverTestLayer,
              serverHttpTestLayer,
            ),
          ),
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
