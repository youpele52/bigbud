import { TerminalExecutionTargetError } from "@bigbud/contracts";
import { Effect } from "effect";

import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { assertSshExecutionTargetReady } from "../../ssh/sshVerification.ts";
import type { TerminalCwdError } from "@bigbud/contracts";

export function makeAssertExecutionTargetReady(
  assertValidCwd: (cwd: string) => Effect.Effect<void, TerminalCwdError>,
) {
  return (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly executionTargetId: string;
    readonly cwd: string;
  }) =>
    isLocalExecutionTarget(input.executionTargetId)
      ? assertValidCwd(input.cwd)
      : Effect.try({
          try: () => assertSshExecutionTargetReady(input.executionTargetId),
          catch: (cause) =>
            new TerminalExecutionTargetError({
              threadId: input.threadId,
              terminalId: input.terminalId,
              executionTargetId: input.executionTargetId,
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });
}
