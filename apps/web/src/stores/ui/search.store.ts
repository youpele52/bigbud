import { type MessageId, type ThreadId } from "@bigbud/contracts";
import { create } from "zustand";

interface SearchFocusRequest {
  threadId: ThreadId;
  messageId: MessageId;
  requestId: number;
}

/** A terminal search hit to reveal: the terminal's find bar opens on this query and line. */
export interface TerminalFindRequest {
  threadId: ThreadId;
  terminalId: string;
  query: string;
  lineText: string;
  requestId: number;
  /** `Date.now()` when requested; a request no view picked up soon after is stale. */
  createdAt: number;
}

/** A hit's terminal mounts right after navigation; later than this the request is abandoned. */
export const TERMINAL_FIND_REQUEST_TTL_MS = 15_000;

export interface FileSearchContext {
  readonly path: string;
  readonly contents: string;
  readonly onSelectMatch: (line: number) => void;
}

interface SearchState {
  searchOpen: boolean;
  fileSearchContext: FileSearchContext | null;
  activeFileSearchContext: FileSearchContext | null;
  focusRequest: SearchFocusRequest | null;
  terminalFindRequest: TerminalFindRequest | null;
  setSearchOpen: (open: boolean) => void;
  toggleSearchOpen: () => void;
  setFileSearchContext: (context: FileSearchContext) => void;
  clearFileSearchContext: (context: FileSearchContext) => void;
  openSearchForFileContext: () => boolean;
  requestMessageFocus: (threadId: ThreadId, messageId: MessageId) => void;
  clearFocusRequest: (requestId: number) => void;
  requestTerminalFind: (request: Omit<TerminalFindRequest, "requestId" | "createdAt">) => void;
  clearTerminalFindRequest: (requestId: number) => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  searchOpen: false,
  fileSearchContext: null,
  activeFileSearchContext: null,
  focusRequest: null,
  terminalFindRequest: null,
  setSearchOpen: (open) =>
    set((state) =>
      state.searchOpen === open
        ? state
        : {
            searchOpen: open,
            activeFileSearchContext: open ? state.activeFileSearchContext : null,
          },
    ),
  toggleSearchOpen: () =>
    set((state) => ({
      searchOpen: !state.searchOpen,
      activeFileSearchContext: state.searchOpen ? null : state.activeFileSearchContext,
    })),
  setFileSearchContext: (context) => set({ fileSearchContext: context }),
  clearFileSearchContext: (context) =>
    set((state) => (state.fileSearchContext === context ? { fileSearchContext: null } : state)),
  openSearchForFileContext: () => {
    const context = useSearchStore.getState().fileSearchContext;
    if (!context) return false;
    set({ searchOpen: true, activeFileSearchContext: context });
    return true;
  },
  requestMessageFocus: (threadId, messageId) =>
    set((state) => ({
      focusRequest: {
        threadId,
        messageId,
        requestId: state.focusRequest ? state.focusRequest.requestId + 1 : 1,
      },
    })),
  clearFocusRequest: (requestId) =>
    set((state) => (state.focusRequest?.requestId === requestId ? { focusRequest: null } : state)),
  requestTerminalFind: (request) =>
    set((state) => ({
      terminalFindRequest: {
        ...request,
        requestId: (state.terminalFindRequest?.requestId ?? 0) + 1,
        createdAt: Date.now(),
      },
    })),
  clearTerminalFindRequest: (requestId) =>
    set((state) =>
      state.terminalFindRequest?.requestId === requestId ? { terminalFindRequest: null } : state,
    ),
}));
