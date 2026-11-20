import * as Effect from "effect/Effect";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { isRemoteAgentExecutionTarget } from "../../remote-agent/remoteAgentDefault.ts";
import { remoteAgentShellLaunchFromProfile } from "../../remote-agent/remoteAgentShellLaunch.profile.ts";
import type { ResolvedShellProfileLaunch } from "./ShellProfiles.launch";

/** Pure intent validation runs before any replacement side effects, and again at dispatch. */
export const resolveTerminalRemoteShellIntent = Effect.fn("terminal.resolveRemoteShellIntent")(
  function* (input: {
    threadId: string;
    terminalId: string;
    executionTargetId: string;
    cwd: string;
    launch: ResolvedShellProfileLaunch | null | undefined;
    recoverOnly?: boolean;
  }) {
    if (!input.launch || isLocalExecutionTarget(input.executionTargetId)) return undefined;
    const launch = input.launch;
    return yield* Effect.try({
      try: () => {
        if (!isRemoteAgentExecutionTarget(input.executionTargetId)) return undefined;
        if (input.recoverOnly)
          throw new Error("Explicit shell launch requires a new owned remote-agent process.");
        return remoteAgentShellLaunchFromProfile({
          executionTargetId: input.executionTargetId,
          cwd: input.cwd,
          launch,
        });
      },
      catch: (cause) =>
        new TerminalExecutionTargetError({
          threadId: input.threadId,
          terminalId: input.terminalId,
          executionTargetId: input.executionTargetId,
          detail:
            "The selected profile does not match this remote target; no replacement was started.",
          cause,
        }),
    });
  },
);
