import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import type { ShellSelection } from "@bigbud/contracts/workspace/terminalShell.ts";
import type { TerminalWslIdentity } from "@bigbud/contracts/workspace/terminal.wsl.ts";
import * as Effect from "effect/Effect";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { isRemoteAgentExecutionTarget } from "../../remote-agent/remoteAgentDefault.ts";
import { remoteShellHost } from "./ShellProfiles.remote.identity";
import { sameShellHost } from "./ShellProfiles.launch";
import { LOCAL_SHELL_HOST } from "./ShellProfiles.identity";
import type { TerminalManagerOptions, TerminalSessionState } from "./Manager.types";

/** Reattach verifies retained evidence only; requested intent never becomes actual identity. */
export const assertTerminalShellReattach = Effect.fn("terminal.assertShellReattach")(function* (
  session: TerminalSessionState,
  executionTargetId: string,
  selection: ShellSelection | undefined,
) {
  if (selection?.kind !== "profile") return;
  const actual = session.shellLaunchIdentity;
  if (
    isLocalExecutionTarget(executionTargetId) &&
    isLocalExecutionTarget(session.executionTargetId) &&
    actual?.host.kind === "local" &&
    actual.selection.kind === "profile" &&
    actual.selection.profileId === selection.profileId
  )
    return;
  const requested = session.shellUnconfirmedLaunch?.requestedProfile;
  if (
    executionTargetId === session.executionTargetId &&
    requested?.profileId === selection.profileId &&
    sameShellHost(
      requested.host,
      remoteShellHost({
        executionTargetId,
        ...(session.wslIdentity ? { wslIdentity: session.wslIdentity } : {}),
      }),
    )
  )
    return;
  return yield* new TerminalExecutionTargetError({
    threadId: session.threadId,
    terminalId: session.terminalId,
    executionTargetId,
    detail:
      "The running terminal does not match the selected profile. Open a new terminal or confirm a replacement.",
  });
});

/** Only qualified actual identity can donate a selection to a NEW process. */
export const terminalShellSelectionForNewProcess = Effect.fn(
  "terminal.shellSelectionForNewProcess",
)(function* (input: {
  threadId: string;
  terminalId: string;
  executionTargetId: string;
  selection?: ShellSelection | undefined;
  existing?: TerminalSessionState | undefined;
}) {
  if (input.selection) return input.selection;
  const previous = input.existing;
  if (
    previous?.shellUnconfirmedLaunch ||
    (previous &&
      !isLocalExecutionTarget(previous.executionTargetId) &&
      !previous.shellLaunchIdentity)
  ) {
    return yield* new TerminalExecutionTargetError({
      threadId: input.threadId,
      terminalId: input.terminalId,
      executionTargetId: input.executionTargetId,
      detail:
        "The previous shell identity is unknown or unconfirmed. Choose a shell explicitly before starting a new process.",
    });
  }
  return previous?.shellLaunchIdentity?.selection;
});

/** Preflight is separate from spawn: invalid profiles/old agents must not stop a live shell. */
export function makeResolveTerminalShellProfile(
  resolve: TerminalManagerOptions["resolveShellProfile"],
  preflightRemote: TerminalManagerOptions["preflightRemoteShellProfile"],
  directShellOwners?: TerminalManagerOptions["directShellOwners"],
) {
  return Effect.fn("terminal.resolveShellProfile")(function* (input: {
    threadId: string;
    terminalId: string;
    executionTargetId: string;
    selection?: ShellSelection | undefined;
    wslIdentity?: TerminalWslIdentity | undefined;
  }) {
    const selection = input.selection ?? { kind: "legacy-auto" };
    if (selection.kind === "legacy-auto") return null;
    const fail = (detail: string) =>
      new TerminalExecutionTargetError({
        threadId: input.threadId,
        terminalId: input.terminalId,
        executionTargetId: input.executionTargetId,
        detail,
      });
    if (!isLocalExecutionTarget(input.executionTargetId)) {
      if (isRemoteAgentExecutionTarget(input.executionTargetId) && !preflightRemote) {
        return yield* fail(
          "Explicit shell profiles require an authenticated durable remote-agent terminal; this execution target is unsupported.",
        );
      }
      if (isRemoteAgentExecutionTarget(input.executionTargetId)) {
        yield* preflightRemote!(input.executionTargetId).pipe(
          Effect.mapError(() =>
            fail(
              "The remote agent does not support owned explicit shell profiles or is unavailable; no replacement was started.",
            ),
          ),
        );
      } else if (!directShellOwners) {
        return yield* fail(
          "Durable direct shell ownership is unavailable; no replacement was started.",
        );
      }
    }
    if (!resolve)
      return yield* fail(
        "Explicit shell profile discovery is unavailable; refresh profiles and retry.",
      );
    const target = {
      executionTargetId: input.executionTargetId,
      ...(input.wslIdentity ? { wslIdentity: input.wslIdentity } : {}),
    };
    const launch = yield* resolve(selection, target).pipe(
      Effect.mapError(() =>
        fail(
          "The selected shell profile is unavailable. Refresh profiles and select an available shell.",
        ),
      ),
    );
    if (!launch)
      return yield* fail(
        "The selected shell profile could not be resolved; no replacement was started.",
      );
    const expectedHost = isLocalExecutionTarget(input.executionTargetId)
      ? LOCAL_SHELL_HOST
      : remoteShellHost(target);
    if (
      !sameShellHost(launch.identity.host, expectedHost) ||
      launch.identity.selection.kind !== "profile" ||
      launch.identity.selection.profileId !== selection.profileId
    )
      return yield* fail(
        "The selected shell profile does not match this execution host; no replacement was started.",
      );
    return launch;
  });
}
