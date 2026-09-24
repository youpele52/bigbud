import type { GetSelectedThreadDetailResult } from "@bigbud/contracts";

import type { AppState } from "./main.store";
import { mergeThreadDetail } from "./mappers.lazy.store";

export function mergeSearchMessageDetail(
  state: AppState,
  detail: GetSelectedThreadDetailResult,
): AppState {
  if (!state.threads.some((thread) => thread.id === detail.threadId)) return state;
  return {
    ...state,
    threads: state.threads.map((thread) =>
      thread.id === detail.threadId ? mergeThreadDetail(thread, detail, true) : thread,
    ),
  };
}
