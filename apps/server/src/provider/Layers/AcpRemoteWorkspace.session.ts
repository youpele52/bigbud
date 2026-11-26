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
import { isRemoteAgentExecutionTarget } from "../../remote-agent/remoteAgentDefault.ts";
import {
  createRemoteWorkspaceAcpBridge,
  type RemoteWorkspaceAcpBridge,
} from "../../remote-workspace-bridge/remoteWorkspaceAcpBridge.ts";
import { isSshOwnerDevFixtureSelected } from "../../ssh/sshOwnerSelection.ts";
import type { SessionFsOwnerWorkspace } from "../../remote-workspace-bridge/remoteWorkspaceSessionFsBridge.owner.ts";
import { DevSshOwnerRuntime } from "../../ssh/sshOwnerDevRuntime.ts";
import {
  makeProductionAcpWorkspace,
  usesProductionAcpBridge,
} from "../../remote-workspace-bridge/remoteWorkspaceAcpBridge.production.ts";
import { isRemoteWorkspaceTarget } from "../../workspace-target/workspaceTarget.ts";
import { ProviderAdapterProcessError, ProviderAdapterValidationError } from "../Errors.ts";
import { resolveProviderExecutionContext } from "../providerExecutionContext.ts";
import type { RemoteWorkspaceReadinessProbe } from "../../remote-workspace-bridge/remoteWorkspaceReadiness.ts";

export const resolveAcpSessionFsOwner = Effect.fn("resolveAcpSessionFsOwner")(function* () {
  if (!isSshOwnerDevFixtureSelected()) return undefined;
  const runtime = yield* Effect.serviceOption(DevSshOwnerRuntime);
  const session = runtime._tag === "Some" ? runtime.value.session : undefined;
  if (session?.kind !== "unix" && session?.kind !== "retained-unix") return undefined;
  const boundWorkspace =
    "guardedWorkspace" in session && session.guardedWorkspace
      ? session.guardedWorkspace
      : {
          targetId: session.targetId,
          workspaceRoot: session.fixture.folder,
          withOwner: session.picker.withOwner,
        };
  const { targetId, workspaceRoot, withOwner } = boundWorkspace;
  const workspace: SessionFsOwnerWorkspace = { targetId, workspaceRoot, withOwner };
  return workspace;
});

export const prepareAcpRemoteWorkspaceSession = Effect.fn("prepareAcpRemoteWorkspaceSession")(
  function* (input: {
    readonly provider: ProviderKind;
    readonly sessionInput: ProviderSessionStartInput;
    readonly ptyResolver: RemoteAgentPtyResolver | undefined;
    readonly orchestrationCleanup: () => Promise<void>;
    readonly sessionFsOwner?: SessionFsOwnerWorkspace;
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
      const workspaceTarget = executionContext.workspaceTarget;
      // W2 T-shell: production activation composes the owner bridge for `ssh:` targets.
      const production = usesProductionAcpBridge(workspaceTarget)
        ? makeProductionAcpWorkspace({
            targetId: workspaceTarget.executionTargetId,
            // An absent root is refused by the session-FS binding, never defaulted.
            workspaceRoot: workspaceTarget.cwd ?? "",
          })
        : undefined;
      const selected = isSshOwnerDevFixtureSelected() || production !== undefined;
      const useRemoteAgentPty =
        !selected &&
        input.ptyResolver !== undefined &&
        isRemoteAgentExecutionTarget(executionContext.workspaceTarget.executionTargetId);
      remoteBridge = yield* Effect.tryPromise({
        try: () =>
          createRemoteWorkspaceAcpBridge({
            workspaceTarget: executionContext.workspaceTarget,
            ptyResolver: useRemoteAgentPty ? input.ptyResolver : undefined,
            prefix: `bigbud-${input.provider}-remote-workspace-`,
            readmeLines: [
              `This directory runs ${input.provider} against a remote workspace.`,
              selected
                ? production
                  ? "Bounded ACP file reads and writes and the approved pwd terminal run through the SSH owner."
                  : "Only bounded ACP file reads and writes are available."
                : useRemoteAgentPty
                  ? "ACP filesystem and terminal requests are routed through the bigbud remote agent."
                  : "ACP filesystem and terminal requests are routed directly over SSH.",
              "",
            ],
            ...(input.readinessProbe ? { readinessProbe: input.readinessProbe } : {}),
            ...(production
              ? {
                  ownerSelected: true,
                  sessionFsOwner: production.sessionFsOwner,
                  acpTerminal: {
                    owner: production.terminalOwner,
                    producer: production.producer,
                    threadId: input.sessionInput.threadId,
                    sessionEpoch: 0,
                  },
                }
              : input.sessionFsOwner
                ? { sessionFsOwner: input.sessionFsOwner }
                : {}),
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
