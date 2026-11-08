import { Data, Effect, Fiber, Option } from "effect";
import {
  ServerRemoteConnectionError,
  type ServerListDisconnectedExecutionTargetsResult,
  type ServerRemoteConnectionInput,
  type ServerRemoteConnectionResult,
} from "@bigbud/contracts/server/server.remoteConnection.ts";

import { notifyRemoteAgentReattachWake } from "../remote-agent/remoteAgentProcessClient.wake.ts";
import { parseSshExecutionTarget } from "../ssh/sshExecutionTarget.ts";
import {
  clearSshTargetDisconnected,
  isSshTargetDisconnected,
  listDisconnectedSshTargets,
  markSshTargetDisconnected,
  RemoteTargetDisconnectedError,
} from "../ssh/sshTargetDisconnects.ts";

export class RemoteDisconnectStepError extends Data.TaggedError("RemoteDisconnectStepError")<{
  readonly step: string;
  readonly cause: unknown;
}> {}

/** One best-effort teardown action; a failure is logged and the remaining steps still run. */
export interface RemoteDisconnectStep {
  readonly name: string;
  readonly run: (
    executionTargetId: string,
    error: RemoteTargetDisconnectedError,
  ) => Effect.Effect<void, RemoteDisconnectStepError>;
}

/** Bounds each teardown step; the guard already prevents reopening if a step gives up. */
export const REMOTE_DISCONNECT_STEP_TIMEOUT_MS = 30_000;

const requireSshTarget = (executionTargetId: string) =>
  parseSshExecutionTarget(executionTargetId)
    ? Effect.void
    : Effect.fail(
        new ServerRemoteConnectionError({
          message: "Only SSH remote workspaces can be disconnected or connected.",
        }),
      );

const runDisconnectStep = (
  step: RemoteDisconnectStep,
  executionTargetId: string,
  error: RemoteTargetDisconnectedError,
) =>
  step.run(executionTargetId, error).pipe(
    Effect.timeoutOption(REMOTE_DISCONNECT_STEP_TIMEOUT_MS),
    Effect.flatMap((completed) =>
      Option.isSome(completed)
        ? Effect.void
        : Effect.logWarning("remote workspace disconnect step timed out", {
            step: step.name,
            executionTargetId,
          }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("remote workspace disconnect step failed", {
        step: step.name,
        executionTargetId,
        cause,
      }),
    ),
  );

/**
 * Persists the disconnect (then enforces it in memory) before closing anything, so a
 * failure part-way through still leaves the target guarded. Runs detached from the RPC
 * fiber: a dropped client cannot stop the teardown after the flag is set. Idempotent:
 * repeating it keeps the flag and reruns the bounded, idempotent teardown.
 */
export const disconnectExecutionTargetEffect = Effect.fn("disconnectExecutionTargetEffect")(
  function* (
    input: ServerRemoteConnectionInput,
    steps: ReadonlyArray<RemoteDisconnectStep>,
  ): Effect.fn.Return<ServerRemoteConnectionResult, ServerRemoteConnectionError> {
    const executionTargetId = input.executionTargetId;
    yield* requireSshTarget(executionTargetId);
    const teardown = yield* Effect.forkDetach(
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => markSshTargetDisconnected(executionTargetId),
          catch: (cause) =>
            new ServerRemoteConnectionError({
              message: "Could not save the disconnect. The remote workspace is still connected.",
              cause,
            }),
        });
        const error = new RemoteTargetDisconnectedError(executionTargetId);
        for (const step of steps) {
          // A Connect that landed mid-teardown wins: never close what it has reopened.
          if (!isSshTargetDisconnected(executionTargetId)) {
            yield* Effect.logDebug("remote workspace disconnect teardown superseded by connect", {
              executionTargetId,
              nextStep: step.name,
            });
            break;
          }
          yield* runDisconnectStep(step, executionTargetId, error);
        }
      }),
    );
    yield* Fiber.join(teardown);
    return { executionTargetId, disconnected: true };
  },
);

/** Clears the flag (persisted first), then wakes reattach loops waiting on the target. */
export const connectExecutionTargetEffect = Effect.fn("connectExecutionTargetEffect")(function* (
  input: ServerRemoteConnectionInput,
  wake: () => void = notifyRemoteAgentReattachWake,
): Effect.fn.Return<ServerRemoteConnectionResult, ServerRemoteConnectionError> {
  const executionTargetId = input.executionTargetId;
  yield* requireSshTarget(executionTargetId);
  yield* Effect.tryPromise({
    try: () => clearSshTargetDisconnected(executionTargetId),
    catch: (cause) =>
      new ServerRemoteConnectionError({
        message: "Could not save the connection. The remote workspace is still disconnected.",
        cause,
      }),
  });
  yield* Effect.sync(wake);
  return { executionTargetId, disconnected: false };
});

export const listDisconnectedExecutionTargetsEffect = (): Effect.Effect<
  ServerListDisconnectedExecutionTargetsResult,
  ServerRemoteConnectionError
> => Effect.sync(() => ({ executionTargetIds: [...listDisconnectedSshTargets()] }));
