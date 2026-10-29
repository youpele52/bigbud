import * as Effect from "effect/Effect";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalSessionState } from "./Manager.types";

export const assertTerminalGeneration = (
  session: TerminalSessionState,
  expectedGeneration: string | undefined,
) =>
  expectedGeneration !== undefined && session.runtimeGeneration !== expectedGeneration
    ? Effect.fail(
        new TerminalExecutionTargetError({
          threadId: session.threadId,
          terminalId: session.terminalId,
          executionTargetId: session.executionTargetId,
          reason: "staleGeneration",
          detail:
            "This terminal has changed since the action was requested. Refresh its status before trying again.",
        }),
      )
    : Effect.void;
