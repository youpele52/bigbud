import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";

import { createCodexRemoteWorkspaceBridge } from "../../../codex/codexRemoteWorkspaceBridge.ts";
import type { ThreadOrchestrationBridge } from "../../../orchestration-tools/orchestrationMcpBridge.ts";
import type { WorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import type { RemoteWorkspaceReadinessProbe } from "../../../remote-workspace-bridge/remoteWorkspaceReadiness.ts";
import { ProviderAdapterProcessError } from "../../Errors.ts";
import { toMessage } from "./Adapter.types.ts";

export const prepareCodexRemoteWorkspaceBridge = Effect.fn("prepareCodexRemoteWorkspaceBridge")(
  function* (input: {
    readonly workspaceTarget: WorkspaceTarget;
    readonly orchestrationBridge: ThreadOrchestrationBridge;
    readonly threadId: ThreadId;
    readonly readinessProbe: RemoteWorkspaceReadinessProbe | undefined;
  }) {
    return yield* Effect.tryPromise({
      try: () =>
        createCodexRemoteWorkspaceBridge(
          input.workspaceTarget,
          input.orchestrationBridge.httpConfig,
          input.readinessProbe,
        ),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: "codex",
          threadId: input.threadId,
          detail: toMessage(cause, "Failed to prepare Codex remote workspace bridge."),
          cause,
        }),
    }).pipe(
      Effect.tapError(() =>
        Effect.promise(() => input.orchestrationBridge.cleanup()).pipe(Effect.ignore),
      ),
    );
  },
);
