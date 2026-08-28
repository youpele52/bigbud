import path from "node:path";

import {
  LOCAL_EXECUTION_TARGET_ID,
  type ProviderKind,
  type ProviderSessionStartInput,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { composeBridgeCleanups } from "../../orchestration-tools/orchestrationMcpBridge.session.ts";
import { isLocalProviderRuntimeTarget } from "../../provider-runtime/providerRuntimeTarget.ts";
import type { RemoteAgentPtyResolver } from "../../remote-agent/remoteAgentPtyAdapter.ts";
import {
  createRemoteWorkspaceAcpBridge,
  type RemoteWorkspaceAcpBridge,
} from "../../remote-workspace-bridge/remoteWorkspaceAcpBridge.ts";
import { isRemoteWorkspaceTarget } from "../../workspace-target/workspaceTarget.ts";
import { ProviderAdapterProcessError, ProviderAdapterValidationError } from "../Errors.ts";
import { resolveProviderExecutionContext } from "../providerExecutionContext.ts";
import type { RemoteWorkspaceReadinessProbe } from "../../remote-workspace-bridge/remoteWorkspaceReadiness.ts";

export const prepareAcpRemoteWorkspaceSession = Effect.fn("prepareAcpRemoteWorkspaceSession")(
  function* (input: {
    readonly provider: ProviderKind;
    readonly sessionInput: ProviderSessionStartInput;
    readonly ptyResolver: RemoteAgentPtyResolver | undefined;
    readonly orchestrationCleanup: () => Promise<void>;
    readonly readinessProbe?: RemoteWorkspaceReadinessProbe;
  }) {
    const executionContext = resolveProviderExecutionContext({
      providerRuntimeExecutionTargetId: input.sessionInput.providerRuntimeExecutionTargetId,
      workspaceExecutionTargetId: input.sessionInput.workspaceExecutionTargetId,
      executionTargetId: input.sessionInput.executionTargetId,
      cwd: input.sessionInput.cwd,
      defaultProviderRuntimeExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
      useLegacyExecutionTargetForProviderRuntime: false,
    });
    if (!isLocalProviderRuntimeTarget(executionContext.providerRuntimeTarget)) {
      return yield* new ProviderAdapterValidationError({
        provider: input.provider,
        operation: "startSession",
        issue: `Remote provider runtimes are not implemented for '${input.provider}'.`,
      });
    }

    let remoteBridge: RemoteWorkspaceAcpBridge | undefined;
    if (isRemoteWorkspaceTarget(executionContext.workspaceTarget)) {
      remoteBridge = yield* Effect.tryPromise({
        try: () =>
          createRemoteWorkspaceAcpBridge({
            workspaceTarget: executionContext.workspaceTarget,
            ptyResolver: input.ptyResolver,
            prefix: `bigbud-${input.provider}-remote-workspace-`,
            readmeLines: [
              `This directory runs ${input.provider} against a remote workspace.`,
              "ACP filesystem and terminal requests are routed through the bigbud remote agent.",
              "",
            ],
            ...(input.readinessProbe ? { readinessProbe: input.readinessProbe } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: input.provider,
            threadId: input.sessionInput.threadId,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }).pipe(
        Effect.tapError(() => Effect.promise(input.orchestrationCleanup).pipe(Effect.ignore)),
      );
    }

    const localCwd = path.resolve(input.sessionInput.cwd!.trim());
    return {
      executionContext,
      remoteBridge,
      sessionCwd: remoteBridge?.cwd ?? localCwd,
      processCwd: remoteBridge?.cwd ?? localCwd,
      cleanup: composeBridgeCleanups(remoteBridge?.cleanup, input.orchestrationCleanup),
    };
  },
);
