import {
  ServerUnlockSshKeyError,
  type ServerUnlockSshKeyInput,
  type ServerUnlockSshKeyResult,
  ServerVerifyExecutionTargetError,
  type ServerVerifyExecutionTargetInput,
  type ServerVerifyExecutionTargetResult,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { unlockSshExecutionTargetKey, verifySshExecutionTarget } from "../ssh/sshVerification.ts";

export const verifyExecutionTargetEffect = Effect.fn("verifyExecutionTargetEffect")(function* (
  input: ServerVerifyExecutionTargetInput,
): Effect.fn.Return<ServerVerifyExecutionTargetResult, ServerVerifyExecutionTargetError> {
  return yield* Effect.tryPromise({
    try: () =>
      verifySshExecutionTarget({
        executionTargetId: input.executionTargetId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }),
    catch: (cause) =>
      new ServerVerifyExecutionTargetError({
        message: cause instanceof Error ? cause.message : "Failed to verify SSH execution target.",
        cause,
      }),
  });
});

export const unlockSshKeyEffect = Effect.fn("unlockSshKeyEffect")(function* (
  input: ServerUnlockSshKeyInput,
): Effect.fn.Return<ServerUnlockSshKeyResult, ServerUnlockSshKeyError> {
  return yield* Effect.tryPromise({
    try: () =>
      unlockSshExecutionTargetKey({
        executionTargetId: input.executionTargetId,
        passphrase: input.passphrase,
      }),
    catch: (cause) =>
      new ServerUnlockSshKeyError({
        message: cause instanceof Error ? cause.message : "Failed to unlock SSH key.",
        cause,
      }),
  });
});
