import { Data, Effect, Layer, Option } from "effect";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { setThreadRemoteAgentToolHandler } from "../orchestration-tools/ThreadRemoteAgentTools.ts";
import { ServerConfig } from "../startup/config.ts";
import {
  remoteAgentHasManagedBuildReadOnly,
  readRemoteAgentApprovalEvidence,
} from "./remoteAgentLocalControl.approval.ts";
import { RemoteAgentInstallOperationsService } from "./remoteAgentInstall.operation.live.ts";
import { makeRemoteAgentControlHandler } from "./remoteAgentLocalControl.handlers.ts";
import { remoteAgentControlSocketPath } from "./remoteAgentLocalControl.protocol.ts";
import { startRemoteAgentLocalControlServer } from "./remoteAgentLocalControl.server.ts";
import { readRemoteAgentDoctor } from "./remoteAgentLocalControl.doctor.ts";
import { remoteAgentReadOnlyDiagnostics } from "./remoteAgentReadOnlyDiagnostics.ts";

class RemoteAgentControlSocketStartError extends Data.TaggedError(
  "RemoteAgentControlSocketStartError",
)<{ readonly message: string }> {}

/**
 * Build the shared remote-agent control handler from live services, or null when the remote
 * agent is not configured. Used by the CLI socket and by thread agent tools.
 */
export const makeLiveRemoteAgentControlHandler = (
  options: { readonly savedTargetsOnly?: boolean } = {},
) =>
  Effect.gen(function* () {
    const operations = yield* Effect.serviceOption(RemoteAgentInstallOperationsService);
    const projects = yield* Effect.serviceOption(ProjectionProjectRepository);
    if (Option.isNone(operations) || Option.isNone(projects)) return null;
    const services = yield* Effect.services();
    const listSavedTargets = () =>
      Effect.runPromiseWith(services)(projects.value.listAll()).then((rows) =>
        rows.map((row) => ({
          executionTargetId: row.executionTargetId,
          deleted: row.deletedAt !== null,
        })),
      );
    return makeRemoteAgentControlHandler({
      operations: operations.value,
      listSavedTargets,
      hasManagedBuild: (target) => remoteAgentHasManagedBuildReadOnly(target),
      approvalEvidence: (target) => readRemoteAgentApprovalEvidence(target),
      // Read-only registry + pinned inventory probes; never installation/admission or supervisor start.
      status: (target) =>
        remoteAgentReadOnlyDiagnostics(
          target,
          undefined,
          options.savedTargetsOnly ? 5_000 : 15_000,
        ),
      doctor: (target) => readRemoteAgentDoctor(target),
      ...(options.savedTargetsOnly ? { savedTargetsOnly: true } : {}),
    });
  });

/**
 * Start the owner-only remote-agent control socket for `bigbud remote-agent` (D1). Absent
 * remote-agent services or an unavailable platform leave the backend running without it.
 */
export const RemoteAgentLocalControlLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const handle = yield* makeLiveRemoteAgentControlHandler();
    const toolHandle = yield* makeLiveRemoteAgentControlHandler({ savedTargetsOnly: true });
    if (!handle || !toolHandle) return;
    // Thread agent tools share the operation registry but may only address saved targets.
    yield* Effect.acquireRelease(
      Effect.sync(() => setThreadRemoteAgentToolHandler(toolHandle)),
      () => Effect.sync(() => setThreadRemoteAgentToolHandler(null)),
    );
    const config = yield* ServerConfig;
    const socketPath = remoteAgentControlSocketPath(config.stateDir);
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => startRemoteAgentLocalControlServer({ socketPath, handle }),
        catch: (cause) =>
          new RemoteAgentControlSocketStartError({
            message: cause instanceof Error ? cause.message : "Control socket failed to start.",
          }),
      }).pipe(
        Effect.tap(() => Effect.logInfo("remote-agent control socket listening")),
        Effect.catch((cause) =>
          Effect.logWarning("remote-agent control socket unavailable", {
            reason: cause.message,
          }).pipe(Effect.as(null)),
        ),
      ),
      (server) => (server ? Effect.promise(() => server.close()) : Effect.void),
    );
  }),
);
