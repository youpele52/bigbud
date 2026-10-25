import { create } from "zustand";
import { MAX_NOTICE_DISMISSALS } from "./noticeDismissal.retention";

interface State {
  readonly owners: ReadonlyMap<string, symbol>;
  claim: (key: string, owner: symbol) => void;
}

/** Nonpersistent presentation ownership: a mounted warning stays usable, but cannot remount this session. */
export const useTextGenerationWarnings = create<State>((set) => ({
  owners: new Map(),
  claim: (key, owner) =>
    set((state) => {
      // Never evict a seen identity: that would permit a second warning this session.
      // At capacity, suppress unseen warnings until renderer restart rather than violating once-only.
      if (state.owners.has(key) || state.owners.size >= MAX_NOTICE_DISMISSALS) return state;
      const owners = new Map(state.owners);
      owners.set(key, owner);
      return { owners };
    }),
}));
