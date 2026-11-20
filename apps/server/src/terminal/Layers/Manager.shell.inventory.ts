import { isRemoteAgentExecutionTarget } from "../../remote-agent/remoteAgentDefault";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import * as Effect from "effect/Effect";
import { localShellDefaultsEnabled } from "../../constants/terminalShells";
import * as Schema from "effect/Schema";
import { TerminalShellProfileInventory } from "@bigbud/contracts/workspace/terminal.shellProfiles.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { LOCAL_SHELL_HOST } from "./ShellProfiles.identity";
import { remoteShellHost } from "./ShellProfiles.remote.identity";
import { sameShellHost } from "./ShellProfiles.launch";
import type { SessionApiContext, TerminalManagerShape } from "./Manager.session.types";

/** Inventory derives its host/account exclusively from the retained pane under its lock. */
export function makeListTerminalShellProfiles(
  ctx: Pick<
    SessionApiContext,
    "withThreadLock" | "requireSession" | "listShellProfiles" | "listLocalShellProfiles"
  >,
  platform: NodeJS.Platform = process.platform,
): TerminalManagerShape["listShellProfiles"] {
  return (input) => {
    if ("scope" in input)
      return Effect.gen(function* () {
        const enabled = localShellDefaultsEnabled(platform);
        if (!enabled) return { host: LOCAL_SHELL_HOST, profiles: [], localDefaultsEnabled: false };
        const failure = () =>
          new TerminalExecutionTargetError({
            threadId: "settings",
            terminalId: "local-settings",
            executionTargetId: "local",
            detail: "Local shell discovery is unavailable. Refresh and retry.",
          });
        if (!ctx.listLocalShellProfiles) return yield* failure();
        const result = yield* ctx.listLocalShellProfiles().pipe(Effect.mapError(failure));
        return yield* Effect.try({
          try: () => {
            const inventory = Schema.decodeUnknownSync(TerminalShellProfileInventory)(result);
            if (!sameShellHost(inventory.host, LOCAL_SHELL_HOST)) throw new Error("Wrong host");
            return { ...inventory, localDefaultsEnabled: true };
          },
          catch: failure,
        });
      });
    return ctx.withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const session = yield* ctx.requireSession(input.threadId, input.terminalId);
        const failure = () =>
          new TerminalExecutionTargetError({
            threadId: session.threadId,
            terminalId: session.terminalId,
            executionTargetId: session.executionTargetId,
            detail:
              "Shell profile inventory is unavailable for this terminal. Refresh profiles and retry.",
          });
        if (!ctx.listShellProfiles) return yield* failure();
        const target = {
          executionTargetId: session.executionTargetId,
          ...(session.wslIdentity ? { wslIdentity: session.wslIdentity } : {}),
        };
        const result = yield* ctx.listShellProfiles(target).pipe(Effect.mapError(failure));
        return yield* Effect.try({
          try: () => {
            const inventory = Schema.decodeUnknownSync(TerminalShellProfileInventory)(result);
            const host = isLocalExecutionTarget(target.executionTargetId)
              ? LOCAL_SHELL_HOST
              : remoteShellHost(target);
            if (!sameShellHost(host, inventory.host))
              throw new Error("Inventory does not match the retained terminal host.");
            return {
              ...inventory,
              runtimeGeneration: session.runtimeGeneration,
              exactProfileLaunchesEnabled: isLocalExecutionTarget(session.executionTargetId)
                ? localShellDefaultsEnabled(platform)
                : isRemoteAgentExecutionTarget(session.executionTargetId),
            };
          },
          catch: failure,
        });
      }),
    );
  };
}
