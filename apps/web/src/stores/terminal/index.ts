// terminal.store.ts already re-exports selectTerminalEventEntries and selectThreadTerminalState from helpers.store
export * from "./terminal.store";
// Re-export remaining helpers not already re-exported by terminal.store.ts
export {
  EMPTY_TERMINAL_EVENT_ENTRIES,
  MAX_TERMINAL_EVENT_BUFFER,
  DEFAULT_THREAD_TERMINAL_STATE,
  appendTerminalEventEntry,
  assignUniqueGroupId,
  closeThreadTerminal,
  copyTerminalGroups,
  createDefaultThreadTerminalState,
  fallbackGroupId,
  findGroupIndexByTerminalId,
  getDefaultThreadTerminalState,
  isDefaultThreadTerminalState,
  isValidTerminalId,
  launchContextFromStartEvent,
  newThreadTerminal,
  normalizeRunningTerminalIds,
  normalizeTerminalGroups,
  normalizeTerminalIds,
  normalizeThreadTerminalState,
  setThreadActiveTerminal,
  setThreadTerminalActivity,
  setThreadTerminalHeight,
  setThreadTerminalOpen,
  splitThreadTerminal,
  terminalEventBufferKey,
  threadTerminalStateEqual,
  updateTerminalStateByThreadId,
  upsertTerminalIntoGroups,
} from "./helpers.store";
export type {
  TerminalEventEntry,
  ThreadTerminalLaunchContext,
  ThreadTerminalState,
} from "./helpers.store";
