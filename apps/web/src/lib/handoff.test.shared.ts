import type { ThreadId } from "@bigbud/contracts";

import { useStore } from "../stores/main";

export const THREAD_ID = "thread-1" as ThreadId;

export function setThreadState(state: {
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    turnId?: string | null;
    streaming: boolean;
    createdAt: string;
  }>;
  latestTurn?: { turnId: string } | null;
  session?: { status: "ready" | "running"; activeTurnId: string | null } | null;
}) {
  useStore.setState({
    threads: [
      {
        id: THREAD_ID,
        messages: state.messages,
        latestTurn: state.latestTurn ?? null,
        session: state.session ?? null,
      },
    ],
    sidebarThreadsById: {
      [THREAD_ID]: {
        id: THREAD_ID,
        session: state.session ?? null,
      },
    },
  } as never);
}
