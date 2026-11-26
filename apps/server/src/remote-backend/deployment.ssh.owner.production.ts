import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { pipeline } from "node:stream/promises";

import { parseSshExecutionTarget } from "../ssh/sshExecutionTarget.ts";
import type { DeploymentStepState } from "../ssh/sshOwnerPickerProof.codec.backend.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.codec.wire.ts";
import {
  matchProductionDeploymentStep,
  type ProductionStep,
  type ProductionStepInput,
} from "./deployment.ssh.owner.production.match.ts";
import {
  deploymentError,
  DEPLOYMENT_REQUEST_ID,
  type DeploymentRemoteResult,
  type DeploymentRemoteRunner,
} from "./deployment.types.ts";

/**
 * W2 T-backend production deployment runner. Under production activation every remote
 * deployment command becomes one typed step lease on the live Rust owner, for the exact
 * target and its own trust policy. The live owner is read per command, so an owner death
 * is a typed refusal and never a stale handle. There is no legacy fallback: an unmatched
 * command, an absent owner or an unresolvable target is refused before any dispatch.
 *
 * A step that was dispatched but not confirmed is `unavailable` with the "not replayed"
 * message; its lease token stays readable on the owner and is never re-opened.
 *
 * @module deployment.ssh.owner.production
 */

export interface ProductionDeploymentDependencies {
  readonly owner: () => SshOwnerProductionRegistration | undefined;
  /** Status poll bounds; tests shorten them. */
  readonly pollMs?: { readonly first: number; readonly max: number };
}

type Bound = ReturnType<SshOwnerProductionRegistration["handle"]["target"]>;

const UNCONFIRMED =
  "The SSH owner could not confirm this deployment step's outcome. " +
  "It was not replayed; reattach by request id.";
/** Wait beyond the owner's own deadline before treating the step as unconfirmed. */
const WAIT_MARGIN_MS = 30_000;

const unavailable = (message: string) => deploymentError("unavailable", message);

/** Typed owner refusals that prove the remote step never ran. */
const REFUSED_BEFORE_DISPATCH = new Set([
  "operationDenied",
  "invalidOperands",
  "configUnsupported",
  "trustRequired",
  "hostKeyChanged",
  "authRequired",
  "staleGeneration",
  "targetUnknown",
  "targetMismatch",
  "sessionQuota",
]);

function ownerFailure(error: unknown) {
  if ((error as { _tag?: unknown })?._tag === "RemoteBackendDeploymentError") return error;
  return error instanceof PickerProofOwnerError && REFUSED_BEFORE_DISPATCH.has(error.code)
    ? unavailable(`The SSH owner refused this deployment step (${error.code}).`)
    : unavailable(UNCONFIRMED);
}

async function bindTarget(
  dependencies: ProductionDeploymentDependencies,
  executionTargetId: string,
): Promise<Bound> {
  if (parseSshExecutionTarget(executionTargetId)?.executionTargetId !== executionTargetId)
    throw deploymentError("invalid-target", "Invalid SSH deployment target.");
  const live = dependencies.owner();
  if (!live) throw unavailable("The SSH owner is not running. Nothing was sent to the host.");
  const descriptor = await live.descriptorFor(executionTargetId).catch(() => undefined);
  if (!descriptor)
    throw unavailable("The SSH owner could not resolve this host. Nothing was sent to it.");
  return live.handle.target(descriptor);
}

async function streamInput(socketPath: string, input: ProductionStepInput, signal: AbortSignal) {
  const socket: Socket = await new Promise((resolve, reject) => {
    const candidate = connect({ path: socketPath, allowHalfOpen: true });
    candidate.once("connect", () => resolve(candidate));
    candidate.once("error", reject);
  });
  socket.on("error", () => {});
  try {
    if (input.kind === "text") {
      await new Promise<void>((resolve, reject) =>
        socket.end(Buffer.from(input.text), (error?: Error | null) =>
          error ? reject(error) : resolve(),
        ),
      );
    } else {
      await pipeline(createReadStream(input.path), socket, { signal, end: true });
    }
  } finally {
    // The owner never writes to this socket; release it once the input is sent.
    socket.destroy();
  }
}

/** Drive one step lease to a settled state. Abort cancels this lease only. */
async function runStep(
  bound: Bound,
  step: ProductionStep,
  signal: AbortSignal,
  poll: { readonly first: number; readonly max: number },
): Promise<DeploymentStepState> {
  signal.throwIfAborted();
  let operands = step.operands;
  if (step.input?.kind === "file") {
    const { size } = await stat(step.input.path);
    operands = { ...operands, maxBytes: size };
  }
  const lease = randomBytes(32);
  const deadline = Date.now() + step.timeoutMs + WAIT_MARGIN_MS;
  let state = await bound.openDeploymentStep(lease, operands);
  const cancel = () => bound.cancelDeploymentStep(lease).catch(() => undefined);
  try {
    if (step.input) {
      if (state.phase !== "listening") throw unavailable(UNCONFIRMED);
      await streamInput(state.socketPath, step.input, signal);
    }
    let wait = poll.first;
    while (state.phase === "listening" || state.phase === "running") {
      signal.throwIfAborted();
      if (Date.now() > deadline) throw unavailable(UNCONFIRMED);
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, poll.max);
      state = await bound.deploymentStepStatus(lease);
    }
    return state;
  } catch (error) {
    await cancel();
    throw error;
  }
}

function settledResult(state: DeploymentStepState): DeploymentRemoteResult {
  if (state.phase !== "exited") throw unavailable(UNCONFIRMED);
  return { code: state.exitCode, stdout: state.stdout, stderr: state.stderr };
}

/** The production runner: legacy command in, one typed owner step out. */
export function makeProductionDeploymentRunner(
  dependencies: ProductionDeploymentDependencies,
): DeploymentRemoteRunner {
  const poll = dependencies.pollMs ?? { first: 50, max: 1_000 };
  const execute = async (executionTargetId: string, step: ProductionStep, signal: AbortSignal) => {
    const bound = await bindTarget(dependencies, executionTargetId);
    let state: DeploymentStepState;
    try {
      state = await runStep(bound, step, signal, poll);
    } catch (error) {
      signal.throwIfAborted();
      throw ownerFailure(error);
    }
    signal.throwIfAborted();
    return settledResult(state);
  };
  const run: DeploymentRemoteRunner = async (executionTargetId, command, signal) => {
    signal.throwIfAborted();
    return execute(executionTargetId, matchProductionDeploymentStep(command), signal);
  };
  return Object.assign(run, {
    readCompletion: (
      scope: { executionTargetId: string; authorityId: string; requestId: string },
      signal: AbortSignal,
    ) => {
      if (!/^[a-f0-9]{32}$/.test(scope.authorityId) || !DEPLOYMENT_REQUEST_ID.test(scope.requestId))
        throw deploymentError("invalid-target", "Invalid deployment completion scope.");
      return execute(
        scope.executionTargetId,
        { operands: { kind: "readCompletion", authorityId: scope.authorityId }, timeoutMs: 30_000 },
        signal,
      );
    },
  });
}

/**
 * Production host trust for deployment: the owner verifies the exact target against its
 * own trust store. Anything but a verified key is a refusal; approval stays in the UI.
 */
export function makeProductionDeploymentHostTrust(
  dependencies: Pick<ProductionDeploymentDependencies, "owner">,
) {
  return async (executionTargetId: string): Promise<void> => {
    const bound = await bindTarget(dependencies, executionTargetId);
    const trust = await bound.inspectTrust();
    if (trust.state !== "verified")
      throw unavailable("The SSH host identity is not approved for this target.");
  };
}
