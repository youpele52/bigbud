import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";

import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { makeSshMonitorHandlers } from "../ws/wsSshMonitor.handlers.ts";
import { makeWsSshOwnerDevHandlers } from "../ws/wsSshOwnerDev.ts";
import { forgetSshMonitorInstance, sshMonitorLease } from "./sshMonitor.connections.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.ts";
import { DevSshOwnerRuntime, makeDevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import { pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";

const instanceId = "selected-monitor";
const caller = `${instanceId}:1`;
const projectId = Schema.decodeUnknownSync(ProjectId)("selected-monitor-project");

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "uses native reachability in the selected monitor handlers, without granting legacy stats",
  async () => {
    const root = await mkdtemp("/private/tmp/bigbud-monitor-rpc-");
    try {
      vi.stubEnv("BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE", undefined);
      vi.stubEnv(
        "BIGBUD_SSH_OWNER_BIN",
        process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
          fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
      activateDevSshOwner();
      await storageScope(path.join(root, "state.sqlite"), (sql) =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeDevSshOwnerRuntime();
            if (session?.kind !== "unix" || !("connectionStarts" in session.fixture))
              throw new Error("Expected the disposable macOS direct fixture");
            const { fixture, targetId, picker } = session;
            const selected = yield* makeWsSshOwnerDevHandlers(instanceId).pipe(
              Effect.provideService(DevSshOwnerRuntime, { session }),
            );
            if (!selected?.monitorHealth) throw new Error("Missing selected health adapter");
            const projects = yield* ProjectionProjectRepository;
            const timestamp = new Date().toISOString();
            const project = {
              projectId,
              title: "Disposable fixture",
              providerRuntimeExecutionTargetId: "local",
              workspaceExecutionTargetId: targetId,
              executionTargetId: targetId,
              workspaceRoot: fixture.folder,
              defaultModelSelection: null,
              scripts: [],
              createdAt: timestamp,
              updatedAt: timestamp,
              deletingAt: null,
              deletedAt: null,
            };
            yield* projects.upsert(project);
            yield* projects.upsert({
              ...project,
              projectId: Schema.decodeUnknownSync(ProjectId)("different-root"),
              workspaceRoot: path.dirname(fixture.folder),
            });
            const context = {
              projectionProjectRepository: Option.some(projects),
              monitorInstanceId: instanceId,
            };
            const monitor = makeSshMonitorHandlers(context, selected.monitorHealth);
            const list = (clientId = 1) =>
              monitor[WS_METHODS.serverListConnectedSshMonitors]({}, { clientId });
            const input = { executionTargetId: targetId, cwd: fixture.folder };
            const verify = () =>
              selected.handlers[WS_METHODS.serverVerifyExecutionTarget](input, { clientId: 1 });
            const starts = fixture.connectionStarts();
            expect(yield* list()).toEqual([]);
            expect(fixture.connectionStarts()).toBe(starts);
            const untrusted = yield* Effect.flip(verify());
            expect(sshMonitorLease(targetId, caller)).toBeNull();
            expect(untrusted.message.startsWith(SSH_HOST_TRUST_REQUIRED_PREFIX)).toBe(true);
            const { challengeId } = Schema.decodeUnknownSync(SshHostTrustChallenge)(
              JSON.parse(untrusted.message.slice(SSH_HOST_TRUST_REQUIRED_PREFIX.length)),
            );
            yield* selected.handlers[WS_METHODS.serverTrustSshHost]({
              executionTargetId: targetId,
              challengeId,
            });
            yield* selected.handlers[WS_METHODS.serverVerifyExecutionTarget](input);
            expect(sshMonitorLease(targetId, caller)).toBeNull();
            yield* verify();

            const beforeHealth = fixture.connectionStarts();
            expect(yield* list(2)).toEqual([]);
            expect(fixture.connectionStarts()).toBe(beforeHealth);
            expect(yield* list()).toEqual([{ projectId, name: project.title, target: targetId }]);
            expect(fixture.connectionStarts()).toBe(beforeHealth + 1);
            expect(yield* list()).toHaveLength(1);
            expect(
              yield* Effect.flip(
                monitor[WS_METHODS.serverSampleSshMonitor]({ projectId }, { clientId: 1 }),
              ),
            ).toContain("unavailable");
            expect(
              yield* makeSshMonitorHandlers(context)[WS_METHODS.serverListConnectedSshMonitors](
                {},
                { clientId: 1 },
              ),
            ).toEqual([]);
            expect(fixture.connectionStarts()).toBe(beforeHealth + 1);

            yield* selected.handlers[WS_METHODS.serverDisconnectExecutionTarget](input);
            expect(sshMonitorLease(targetId, caller)).toBeNull();
            expect(yield* list()).toEqual([]);
            yield* selected.handlers[WS_METHODS.serverConnectExecutionTarget](input);
            expect(yield* list()).toEqual([]);
            expect(fixture.connectionStarts()).toBe(beforeHealth + 1);
            yield* verify();

            vi.useFakeTimers({ toFake: ["Date"] });
            const expire = () => vi.setSystemTime(Date.now() + 5_001);
            yield* Effect.promise(fixture.stop);
            expire();
            expect(yield* list()).toEqual([]);
            expect(sshMonitorLease(targetId, caller)).toBeNull();
            yield* Effect.promise(() => fixture.start());
            yield* verify();
            const replacement = sshMonitorLease(targetId, caller);
            expect(replacement).not.toBeNull();
            const beforeClose = fixture.connectionStarts();
            yield* Effect.promise(picker.close);
            expire();
            expect(yield* list()).toEqual([]);
            expect(sshMonitorLease(targetId, caller)).toBe(replacement);
            expect(fixture.connectionStarts()).toBe(beforeClose);
            expect(yield* Effect.promise(fixture.launchNames)).toEqual([]);
          }).pipe(
            Effect.provide(ProjectionProjectRepositoryLive),
            Effect.provideService(SqlClient, sql),
          ),
        ),
      );
    } finally {
      forgetSshMonitorInstance(instanceId);
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
