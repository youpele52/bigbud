import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { isCurrentTerminalSnapshot } from "../../lib/terminalLaunchBinding";
import { terminalProfileKey, type TerminalProfileLaunch } from "../../lib/terminalProfileLaunch";
import { hydrateTerminalAgentFromSnapshot as hydrateAgent } from "./terminal.store.identity";
import type { TerminalStateStoreState } from "./terminal.store.types";

type ProfileState = Pick<TerminalStateStoreState, "terminalProfileLaunches">;

/** Persist launch intent from server evidence, never persist it as actual shell identity. */
export function reconcileTerminalProfileLaunches(
  state: ProfileState,
  snapshot: TerminalSessionSnapshot,
): ProfileState {
  if (!isCurrentTerminalSnapshot(snapshot)) return state;
  const key = terminalProfileKey(snapshot.threadId, snapshot.terminalId);
  const previous = state.terminalProfileLaunches[key];
  const actual = snapshot.shellLaunchIdentity;
  const requested = snapshot.shellUnconfirmedLaunch?.requestedProfile;
  if (!previous && !actual && !requested) return state;
  const next: TerminalProfileLaunch = {
    ...(actual
      ? { shellSelection: actual.selection, host: actual.host }
      : requested
        ? {
            shellSelection: { kind: "profile", profileId: requested.profileId },
            host: requested.host,
          }
        : {}),
    context: {
      cwd: snapshot.cwd,
      worktreePath: snapshot.worktreePath,
      executionTargetId: snapshot.executionTargetId,
      runtimeEnv: snapshot.runtimeEnv,
    },
  };
  if (JSON.stringify(previous) === JSON.stringify(next)) return state;
  return { terminalProfileLaunches: { ...state.terminalProfileLaunches, [key]: next } };
}

export function hydrateTerminalAgentFromSnapshot(
  state: TerminalStateStoreState,
  snapshot: TerminalSessionSnapshot,
) {
  const profiles = reconcileTerminalProfileLaunches(state, snapshot);
  return {
    ...hydrateAgent(state, snapshot),
    terminalProfileLaunches: profiles.terminalProfileLaunches,
  };
}
