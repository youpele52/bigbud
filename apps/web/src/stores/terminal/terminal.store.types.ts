import { type ThreadId, type TerminalEvent } from "@bigbud/contracts";

import {
  type TerminalEventEntry,
  type ThreadTerminalLaunchContext,
  type ThreadTerminalState,
} from "./helpers.store";

export interface TerminalStateStoreState {
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
  panelTerminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
  terminalLabelOverridesByThreadId: Record<ThreadId, Record<string, string>>;
  terminalLaunchContextByThreadId: Record<ThreadId, ThreadTerminalLaunchContext>;
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>;
  terminalEventLastIdsByKey: Record<string, number>;
  nextTerminalEventId: number;
  setTerminalOpen: (threadId: ThreadId, open: boolean) => void;
  setTerminalHeight: (threadId: ThreadId, height: number) => void;
  splitTerminal: (threadId: ThreadId, terminalId: string) => void;
  newTerminal: (threadId: ThreadId, terminalId: string) => void;
  ensureTerminal: (
    threadId: ThreadId,
    terminalId: string,
    options?: { open?: boolean; active?: boolean },
  ) => void;
  setActiveTerminal: (threadId: ThreadId, terminalId: string) => void;
  closeTerminal: (threadId: ThreadId, terminalId: string) => void;
  setTerminalLabelOverride: (threadId: ThreadId, terminalId: string, label: string) => void;
  clearTerminalLabelOverride: (threadId: ThreadId, terminalId: string) => void;
  setPanelTerminalOpen: (threadId: ThreadId, open: boolean) => void;
  setPanelTerminalHeight: (threadId: ThreadId, height: number) => void;
  splitPanelTerminal: (threadId: ThreadId, terminalId: string) => void;
  newPanelTerminal: (threadId: ThreadId, terminalId: string) => void;
  ensurePanelTerminal: (
    threadId: ThreadId,
    terminalId: string,
    options?: { open?: boolean; active?: boolean },
  ) => void;
  setPanelActiveTerminal: (threadId: ThreadId, terminalId: string) => void;
  closePanelTerminal: (threadId: ThreadId, terminalId: string) => void;
  setTerminalLaunchContext: (threadId: ThreadId, context: ThreadTerminalLaunchContext) => void;
  clearTerminalLaunchContext: (threadId: ThreadId) => void;
  setTerminalActivity: (
    threadId: ThreadId,
    terminalId: string,
    hasRunningSubprocess: boolean,
  ) => void;
  recordTerminalEvent: (event: TerminalEvent) => void;
  applyTerminalEvent: (event: TerminalEvent) => void;
  applyTerminalEvents: (events: ReadonlyArray<TerminalEvent>) => void;
  clearTerminalState: (threadId: ThreadId) => void;
  removeTerminalState: (threadId: ThreadId) => void;
  removeOrphanedTerminalStates: (activeThreadIds: Set<ThreadId>) => void;
}
