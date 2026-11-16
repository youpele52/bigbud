import type { RemoteAgentApprovalEvidence } from "./remoteAgentLocalControl.approval.ts";
import type { RemoteAgentInstallOperations } from "./remoteAgentInstall.operation.ts";
import {
  isRemoteAgentTargetApproved,
  resolveRemoteAgentTarget,
  type RemoteAgentSavedTarget,
} from "./remoteAgentLocalControl.targets.ts";
import {
  REMOTE_AGENT_CONTROL_VERSION,
  type RemoteAgentConsentRequired,
  type RemoteAgentControlRequest,
  type RemoteAgentControlResponse,
} from "./remoteAgentLocalControl.protocol.ts";
import { remoteAgentFailureDetail } from "./remoteAgentFailure.ts";

export interface RemoteAgentControlHandlerDependencies {
  readonly operations: RemoteAgentInstallOperations;
  readonly listSavedTargets: () => Promise<ReadonlyArray<RemoteAgentSavedTarget>>;
  readonly hasManagedBuild: (executionTargetId: string) => Promise<boolean>;
  readonly approvalEvidence?: (executionTargetId: string) => Promise<RemoteAgentApprovalEvidence>;
  /** Read-only health/version check of the target. */
  readonly status: (executionTargetId: string) => Promise<unknown>;
  /** Read-only platform and prerequisite report. */
  readonly doctor: (executionTargetId: string) => Promise<unknown>;
  /** Agent tools may only address saved targets; explicit target IDs are CLI-only. */
  readonly savedTargetsOnly?: boolean;
}

const ok = (result: unknown): RemoteAgentControlResponse => ({
  v: REMOTE_AGENT_CONTROL_VERSION,
  ok: true,
  result,
});

/**
 * Resolve the request's target, apply the D5 approval rule and dispatch to the shared install
 * operation. Install returns an operation ID immediately; clients poll `operation`.
 */
export function makeRemoteAgentControlHandler(dependencies: RemoteAgentControlHandlerDependencies) {
  return async (request: RemoteAgentControlRequest): Promise<RemoteAgentControlResponse> => {
    if (request.method === "operation") {
      const snapshot = await dependencies.operations.wait(request.operationId, request.waitMs);
      return snapshot
        ? ok(snapshot)
        : {
            v: REMOTE_AGENT_CONTROL_VERSION,
            ok: false,
            error: { code: "target", message: "Unknown or expired operation." },
          };
    }
    const resolved = resolveRemoteAgentTarget(
      request.target,
      await dependencies.listSavedTargets(),
      { savedOnly: dependencies.savedTargetsOnly === true },
    );
    if (!resolved.ok) {
      return {
        v: REMOTE_AGENT_CONTROL_VERSION,
        ok: false,
        error: { code: "target", message: resolved.message },
      };
    }
    const target = resolved.executionTargetId;
    // One approval probe per request: an unsaved host costs a remote registry read.
    let approval: Promise<RemoteAgentApprovalEvidence> | undefined;
    const evidence = (): Promise<RemoteAgentApprovalEvidence> =>
      (approval ??= resolved.saved
        ? Promise.resolve({ approved: true, unreadable: false })
        : dependencies.approvalEvidence
          ? dependencies
              .approvalEvidence(target)
              .catch(() => ({ approved: false, unreadable: true }))
          : isRemoteAgentTargetApproved({
              executionTargetId: target,
              saved: false,
              hasManagedBuild: dependencies.hasManagedBuild,
            }).then((approved) => ({ approved, unreadable: false })));
    const approved = async () => (await evidence()).approved;
    try {
      if (!resolved.saved && (request.method !== "install" || !request.consent)) {
        const trustFailure = (await evidence()).hostTrustFailure;
        if (trustFailure)
          return {
            v: REMOTE_AGENT_CONTROL_VERSION,
            ok: false,
            error: { code: "unavailable", message: trustFailure },
          };
      }
      if (request.method === "status" || request.method === "doctor") {
        // Never touch an unapproved, unsaved host beyond the read-only approval probe.
        if (!resolved.saved && !(await approved())) {
          const diagnostic = (await evidence()).unreadable
            ? {
                status: "unreadable",
                message:
                  "The remote agent registry could not be read. Approval is unconfirmed; check SSH access and directory permissions.",
              }
            : undefined;
          return ok({
            executionTargetId: target,
            approved: false,
            health: diagnostic ?? "not-checked",
            ...(request.method === "doctor" && diagnostic ? { report: { agent: diagnostic } } : {}),
          });
        }
      }
      if (request.method === "status") {
        return ok({
          executionTargetId: target,
          approved: await approved(),
          health: await dependencies.status(target),
        });
      }
      if (request.method === "doctor") {
        return ok({ executionTargetId: target, report: await dependencies.doctor(target) });
      }
    } catch (cause) {
      return {
        v: REMOTE_AGENT_CONTROL_VERSION,
        ok: false,
        error: { code: "unavailable", message: remoteAgentFailureDetail(cause) },
      };
    }
    if (!request.consent && !(await approved())) {
      const required: RemoteAgentConsentRequired = {
        status: "consent-required",
        executionTargetId: target,
        message:
          "This host has not been approved in bigbud. Installing the agent places a bigbud program in ~/.bigbud/agent on it.",
      };
      return ok(required);
    }
    let started;
    try {
      started = dependencies.operations.start({
        executionTargetId: target,
        replace: request.replace,
        ...(request.operationId ? { operationId: request.operationId } : {}),
      });
    } catch (cause) {
      return {
        v: REMOTE_AGENT_CONTROL_VERSION,
        ok: false,
        error: { code: "busy", message: remoteAgentFailureDetail(cause) },
      };
    }
    if (started.kind === "stage" || (request.replace && started.kind !== "replace")) {
      // A joined operation would not do what was asked: the app's stage-only Install never
      // activates, and a plain install never replaces. Report busy instead of a weaker outcome.
      return {
        v: REMOTE_AGENT_CONTROL_VERSION,
        ok: false,
        error: {
          code: "busy",
          message:
            started.kind === "stage"
              ? `bigbud is staging the agent for this host (operation ${started.operationId}). Retry after it completes.`
              : `An install is already running (operation ${started.operationId}). Retry --replace after it completes.`,
        },
      };
    }
    return ok(started);
  };
}
