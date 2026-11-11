import type { TerminalProfileLaunch } from "../../lib/terminalProfileLaunch";
import { terminalProfileKey } from "../../lib/terminalProfileLaunch";

export interface TerminalProfileReplacement {
  profile: TerminalProfileLaunch;
  expectedGeneration: string;
  isCurrent: () => boolean;
}
type RestartAction = (replacement?: TerminalProfileReplacement) => Promise<void>;
const actions = new Map<string, RestartAction>();

/** Route toolbar intents to the mounted viewport's existing delivery/lifecycle owner. */
export function registerTerminalProfileRestart(
  threadId: string,
  terminalId: string,
  action: RestartAction,
) {
  const key = terminalProfileKey(threadId, terminalId);
  actions.set(key, action);
  return () => {
    if (actions.get(key) === action) actions.delete(key);
  };
}
export async function replaceTerminalProfile(
  threadId: string,
  terminalId: string,
  replacement: TerminalProfileReplacement,
) {
  const action = actions.get(terminalProfileKey(threadId, terminalId));
  if (!action)
    throw new Error("The terminal view is unavailable. Reopen it before replacing its shell.");
  await action(replacement);
}
