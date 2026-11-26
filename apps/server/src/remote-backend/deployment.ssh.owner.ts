import {
  matchGraphManifestPut,
  type DeploymentManifestRequest,
} from "./deployment.ssh.owner.manifest.ts";
import { isRemoteAgentTargetTriple } from "@bigbud/shared/remoteAgentArtifact";
import { parseSshExecutionTarget } from "../ssh/sshExecutionTarget.ts";
import { GRAPH_STAGE_SCRIPT } from "./deployment.fetch.ts";
import { REMOTE_PROBE_SCRIPT, SSH_HOST_KEY_DIR } from "./deployment.remoteSetup.ts";
import {
  deploymentError,
  DEPLOYMENT_REQUEST_ID,
  type DeploymentRemoteCommand,
  type DeploymentRemoteRunner,
} from "./deployment.types.ts";
import {
  classifyDeploymentOutcome,
  deploymentControlRequest,
  validateDeploymentStep,
  type DeploymentStepOutcome,
  type DeploymentStepRequest,
} from "./deployment.ssh.owner.operations.ts";

const HOST_PROBE_TIMEOUT_MS = 30_000;
const MAX_HOST_PROBE_STDOUT_BYTES = 256 * 1024;
const MAX_OUTPUT_STDERR_BYTES = 16 * 1024;
const GRAPH_STAGE_BEGIN_TIMEOUT_MS = 60_000;
const MAX_GRAPH_STAGE_STDOUT_BYTES = 1024;
const GRAPH_INSTALL_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}-([a-z0-9_]{1,8}-unknown-linux-[a-z]{1,4})-([a-f0-9]{16})$/;
const GRAPH_DIGEST = /^[a-f0-9]{64}$/;

export interface DeploymentHostProbeRequest {
  readonly executionTargetId: string;
  readonly action: { readonly kind: "probeHost"; readonly requestId: string };
}

export interface DeploymentCompletionRequest {
  readonly executionTargetId: string;
  readonly action: {
    readonly kind: "readCompletion";
    readonly authorityId: string;
    readonly requestId: string;
  };
}

export interface DeploymentGraphStageBeginRequest {
  readonly executionTargetId: string;
  readonly action: {
    readonly kind: "beginGraphStage";
    readonly requestId: string;
    readonly installName: string;
    readonly archiveSha256: string;
    readonly manifestSha256: string;
  };
}

const probeFailures = {
  "approval-refused": "The SSH owner refused this deployment operation.",
  "trust-refused": "The SSH host identity could not be verified.",
  unsupported: "The SSH owner does not support the deployment host probe.",
  timeout: "The remote host probe timed out.",
  "output-limit": "The remote host probe exceeded its output limit.",
  unavailable: "The SSH owner could not complete the remote host probe.",
} as const;

export type DeploymentHostProbeOutcome =
  | {
      readonly kind: "exited";
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "failed"; readonly reason: keyof typeof probeFailures }
  /** Dispatched without a confirmed result. Never replay; reattach by request id. */
  | { readonly kind: "outcomeUnknown" };

const graphStageFailures: Record<keyof typeof probeFailures, string> = {
  "approval-refused": probeFailures["approval-refused"],
  "trust-refused": probeFailures["trust-refused"],
  unsupported: "The SSH owner does not support beginning graph staging.",
  timeout: "Beginning remote graph staging timed out.",
  "output-limit": "Beginning remote graph staging exceeded its output limit.",
  unavailable: "The SSH owner could not confirm the result of beginning remote graph staging.",
};

export interface DeploymentSshOwner {
  /**
   * Bind the exact target, action and request ID to deployment approval, then verify SSH trust
   * independently before dispatch. The request ID is a correlation operand, not a grant. The
   * probe reports host/receipt information, not SSH credentials or proof of installation.
   * Run only the bundled read-only recipe with empty stdin, a 30 s deadline and bounded output.
   * Return an ordinary recipe exit only after draining both streams and confirming exit; report
   * SSH/owner loss as failure, never as an exit or an empty probe. Honor cancellation of this
   * operation only and never retry or invoke legacy SSH on refusal or uncertain delivery.
   */
  readonly deploymentAction: (
    request: DeploymentHostProbeRequest | DeploymentCompletionRequest,
    signal: AbortSignal,
  ) => Promise<DeploymentHostProbeOutcome>;
  /**
   * Bind the exact target and operands to deployment approval and verify SSH trust independently.
   * Run only the bundled graph `begin` recipe: it may reset this request's staging directory,
   * but does not publish an install. No caller-supplied shell, environment or stdin. Enforce a
   * 60 s deadline and streaming caps of 1 KiB stdout / 16 KiB stderr. Drain both streams and
   * confirm ordinary exit before reporting it. Honor operation-only cancellation. Refusal, timeout
   * or lost delivery is not proof that staging was unchanged; never retry or fall back.
   */
  readonly beginGraphStage?: (
    request: DeploymentGraphStageBeginRequest,
    signal: AbortSignal,
  ) => Promise<DeploymentHostProbeOutcome>;
  readonly putGraphManifest?: (
    request: DeploymentManifestRequest,
    signal: AbortSignal,
  ) => Promise<DeploymentHostProbeOutcome>;
  /**
   * Run one typed deployment step for an exact target and request. The owner selects every
   * program, argument, cwd and environment; operands are validated data. Upload is bounded to
   * 48 KiB of artifact bytes. Cancellation names this operation lease only and `reattach` reads
   * the retained outcome without dispatch. A dispatched step without a confirmed result is
   * `outcomeUnknown`; never replay it, reattach by request id.
   */
  readonly deploymentStep?: (
    request: DeploymentStepRequest,
    signal: AbortSignal,
  ) => Promise<DeploymentStepOutcome>;
}

/** Extra typed surfaces on the owner-selected runner; the legacy runner does not implement them. */
export interface OwnedDeploymentRemoteRunner extends DeploymentRemoteRunner {
  /**
   * Run one typed step through the owner. Operands are validated before dispatch,
   * and an unconfirmed result is a typed refusal that is never retried.
   */
  readonly runDeploymentStep?: (
    request: DeploymentStepRequest,
    signal: AbortSignal,
  ) => Promise<DeploymentStepOutcome>;
  /** Cancel this operation lease only; never a process- or host-wide teardown. */
  readonly cancelDeploymentOperation?: (
    executionTargetId: string,
    requestId: string,
    signal: AbortSignal,
  ) => Promise<DeploymentStepOutcome>;
  /** Read the retained outcome for a known request id. Never dispatches work. */
  readonly reattachDeploymentOperation?: (
    executionTargetId: string,
    requestId: string,
    signal: AbortSignal,
  ) => Promise<DeploymentStepOutcome>;
}

function matchGraphStageBegin(command: DeploymentRemoteCommand) {
  const [flag, script, argv0, op, requestId, installName, archiveSha256, manifestSha256] =
    command.args;
  if (
    command.command !== "/bin/sh" ||
    command.args.length !== 8 ||
    flag !== "-c" ||
    script !== GRAPH_STAGE_SCRIPT ||
    argv0 !== "sh" ||
    op !== "begin" ||
    command.env !== undefined ||
    command.stdin !== undefined ||
    command.timeoutMs !== GRAPH_STAGE_BEGIN_TIMEOUT_MS
  ) {
    return undefined;
  }
  const name = installName && GRAPH_INSTALL_NAME.exec(installName);
  if (
    !requestId ||
    !DEPLOYMENT_REQUEST_ID.test(requestId) ||
    !installName ||
    !name ||
    !isRemoteAgentTargetTriple(name[1]) ||
    !archiveSha256 ||
    !GRAPH_DIGEST.test(archiveSha256) ||
    name[2] !== archiveSha256.slice(0, 16) ||
    !manifestSha256 ||
    !GRAPH_DIGEST.test(manifestSha256)
  ) {
    throw deploymentError("invalid-target", "Invalid deployment graph staging scope.");
  }
  return {
    kind: "beginGraphStage",
    requestId,
    installName,
    archiveSha256,
    manifestSha256,
  } as const;
}

export function makeOwnedDeploymentSshRunner(
  owner: DeploymentSshOwner,
): OwnedDeploymentRemoteRunner {
  const run: DeploymentRemoteRunner = async (executionTargetId, command, signal) => {
    signal.throwIfAborted();
    if (parseSshExecutionTarget(executionTargetId)?.executionTargetId !== executionTargetId) {
      throw deploymentError("invalid-target", "Invalid SSH deployment target.");
    }
    const stage = matchGraphStageBegin(command);
    if (stage) {
      const begin = owner.beginGraphStage;
      if (!begin) throw deploymentError("unavailable", graphStageFailures.unsupported);
      const result = await dispatch(
        () => begin.call(owner, { executionTargetId, action: stage }, signal),
        signal,
        MAX_GRAPH_STAGE_STDOUT_BYTES,
        graphStageFailures,
      );
      if (result.code === 0 && !["present", "staged"].includes(result.stdout.trim())) {
        throw deploymentError("unavailable", graphStageFailures.unavailable);
      }
      return result;
    }
    const manifest = matchGraphManifestPut(command);
    if (manifest) {
      const put = owner.putGraphManifest;
      if (!put)
        throw deploymentError(
          "unavailable",
          "The SSH owner does not support bounded manifest staging.",
        );
      const result = await dispatch(
        () => put.call(owner, { executionTargetId, action: manifest }, signal),
        signal,
        1024,
        {
          ...graphStageFailures,
          unavailable: "The SSH owner could not confirm the manifest put. It was not retried.",
        },
      );
      if (result.code === 0 && result.stdout !== "manifest-stored\n") {
        throw deploymentError("unavailable", "The SSH owner did not confirm the manifest put.");
      }
      return result;
    }
    const [flag, script, argv0, requestId, hostKeyDir] = command.args;
    if (
      command.command !== "/bin/sh" ||
      command.args.length !== 5 ||
      flag !== "-c" ||
      script !== REMOTE_PROBE_SCRIPT ||
      argv0 !== "sh" ||
      hostKeyDir !== SSH_HOST_KEY_DIR ||
      command.env !== undefined ||
      command.stdin !== undefined ||
      command.timeoutMs !== HOST_PROBE_TIMEOUT_MS
    ) {
      throw deploymentError(
        "unavailable",
        "This deployment step is not supported by the SSH owner.",
      );
    }
    if (!requestId || !DEPLOYMENT_REQUEST_ID.test(requestId)) {
      throw deploymentError("invalid-target", "Invalid deployment request ID.");
    }

    return dispatch(
      () =>
        owner.deploymentAction(
          { executionTargetId, action: { kind: "probeHost", requestId } },
          signal,
        ),
      signal,
      MAX_HOST_PROBE_STDOUT_BYTES,
      probeFailures,
    );
  };
  const unconfirmed =
    "The SSH owner could not confirm this deployment step's outcome. " +
    "It was not replayed; reattach by request id.";
  const dispatchStep = async (
    request: DeploymentStepRequest,
    signal: AbortSignal,
    allowUnknown: boolean,
  ): Promise<DeploymentStepOutcome> => {
    signal.throwIfAborted();
    if (
      parseSshExecutionTarget(request.executionTargetId)?.executionTargetId !==
      request.executionTargetId
    ) {
      throw deploymentError("invalid-target", "Invalid SSH deployment target.");
    }
    validateDeploymentStep(request);
    const transport = owner.deploymentStep;
    if (!transport)
      throw deploymentError(
        "unavailable",
        "The SSH owner does not support typed deployment steps.",
      );
    let outcome: DeploymentStepOutcome;
    try {
      outcome = await transport.call(owner, request, signal);
    } catch {
      signal.throwIfAborted();
      throw deploymentError("unavailable", unconfirmed);
    }
    signal.throwIfAborted();
    if (outcome.outcomeUnknown && !allowUnknown) throw deploymentError("unavailable", unconfirmed);
    // Re-project the owner's snapshot onto this request so a reattached or
    // cancelled record always names the operation it belongs to.
    return classifyDeploymentOutcome(
      request,
      {
        code: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        state: outcome.state,
      },
      request.action === "reattach",
    );
  };

  const control =
    (action: "cancel" | "reattach") =>
    async (executionTargetId: string, requestId: string, signal: AbortSignal) => {
      if (!DEPLOYMENT_REQUEST_ID.test(requestId))
        throw deploymentError("invalid-target", "Invalid deployment operation scope.");
      const request = deploymentControlRequest(executionTargetId, requestId, action);
      // Control never dispatches remote work, so a retained unknown state is
      // reported rather than escalating to a dispatch failure.
      return dispatchStep(request, signal, true);
    };

  return Object.assign(run, {
    runDeploymentStep: (request: DeploymentStepRequest, signal: AbortSignal) =>
      dispatchStep(request, signal, false),
    cancelDeploymentOperation: control("cancel"),
    reattachDeploymentOperation: control("reattach"),
    readCompletion: (
      {
        executionTargetId,
        authorityId,
        requestId,
      }: { executionTargetId: string; authorityId: string; requestId: string },
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      if (
        parseSshExecutionTarget(executionTargetId)?.executionTargetId !== executionTargetId ||
        !/^[a-f0-9]{32}$/.test(authorityId) ||
        !DEPLOYMENT_REQUEST_ID.test(requestId)
      ) {
        throw deploymentError("invalid-target", "Invalid deployment completion scope.");
      }
      return dispatch(
        () =>
          owner.deploymentAction(
            { executionTargetId, action: { kind: "readCompletion", authorityId, requestId } },
            signal,
          ),
        signal,
        16 * 1024,
        probeFailures,
      );
    },
  });

  async function dispatch(
    execute: () => Promise<DeploymentHostProbeOutcome>,
    signal: AbortSignal,
    maxStdoutBytes: number,
    failures: Record<keyof typeof probeFailures, string>,
  ) {
    let outcome: DeploymentHostProbeOutcome;
    try {
      outcome = await execute();
    } catch {
      signal.throwIfAborted();
      throw deploymentError("unavailable", failures.unavailable);
    }
    signal.throwIfAborted();
    if (outcome.kind === "outcomeUnknown") {
      throw deploymentError(
        "unavailable",
        "The SSH owner could not confirm this deployment step's outcome. It was not replayed; reattach by request id.",
      );
    }
    if (outcome.kind === "failed") {
      throw deploymentError("unavailable", failures[outcome.reason]);
    }
    const { code, stdout, stderr } = outcome;
    if (!Number.isInteger(code) || code < 0 || code >= 255) {
      throw deploymentError("unavailable", failures.unavailable);
    }
    if (
      Buffer.byteLength(stdout) > maxStdoutBytes ||
      Buffer.byteLength(stderr) > MAX_OUTPUT_STDERR_BYTES
    ) {
      throw deploymentError("unavailable", failures["output-limit"]);
    }
    return { code, stdout, stderr };
  }
}
