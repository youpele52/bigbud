import { type MessageId, type ThreadId } from "@bigbud/contracts";
import { create } from "zustand";

interface SearchFocusRequest {
  threadId: ThreadId;
  messageId: MessageId;
  requestId: number;
}

interface SearchState {
  searchOpen: boolean;
  focusRequest: SearchFocusRequest | null;
  setSearchOpen: (open: boolean) => void;
  toggleSearchOpen: () => void;
  requestMessageFocus: (threadId: ThreadId, messageId: MessageId) => void;
  clearFocusRequest: (requestId: number) => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  searchOpen: false,
  focusRequest: null,
  setSearchOpen: (open) =>
    set((state) => (state.searchOpen === open ? state : { searchOpen: open })),
  toggleSearchOpen: () => set((state) => ({ searchOpen: !state.searchOpen })),
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
}));
