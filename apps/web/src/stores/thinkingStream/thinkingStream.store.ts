import {
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type ThinkingActivityDeltaEvent,
} from "@bigbud/contracts";
import { create } from "zustand";

interface ThinkingStreamState {
  readonly activitiesByThreadId: Record<string, Record<string, OrchestrationThreadActivity>>;
}

interface ThinkingStreamStore extends ThinkingStreamState {
  readonly applyThinkingDelta: (event: ThinkingActivityDeltaEvent) => void;
  readonly reconcilePersistedActivities: (events: ReadonlyArray<OrchestrationEvent>) => void;
  readonly clearAll: () => void;
  readonly clearThread: (threadId: string) => void;
}

const initialState: ThinkingStreamState = {
  activitiesByThreadId: {},
};

const THINKING_ACTIVITY_HEAD_CHARS = 3_000;
const THINKING_ACTIVITY_TAIL_CHARS = 7_000;
const THINKING_ACTIVITY_PERSIST_LIMIT = THINKING_ACTIVITY_HEAD_CHARS + THINKING_ACTIVITY_TAIL_CHARS;
const THINKING_ACTIVITY_TRUNCATION_MARKER = "\n\n[... truncated ...]\n\n";

function thinkingActivityKind(streamKind: ThinkingActivityDeltaEvent["streamKind"]): string {
  return streamKind === "reasoning_summary_text" ? "thinking.summary" : "thinking.stream";
}

function thinkingActivitySummary(streamKind: ThinkingActivityDeltaEvent["streamKind"]): string {
  return streamKind === "reasoning_summary_text" ? "Thinking summary" : "Thinking";
}

function appendThinkingDetail(input: {
  readonly detail: string;
  readonly delta: string;
  readonly fullCharCount: number;
  readonly truncated: boolean;
}): {
  readonly detail: string;
  readonly fullCharCount: number;
  readonly persistedCharCount: number;
  readonly truncated: boolean;
} {
  const fullCharCount = input.fullCharCount + input.delta.length;
  if (!input.truncated) {
    const nextDetail = `${input.detail}${input.delta}`;
    if (nextDetail.length <= THINKING_ACTIVITY_PERSIST_LIMIT) {
      return {
        detail: nextDetail,
        fullCharCount,
        persistedCharCount: nextDetail.length,
        truncated: false,
      };
    }

    const detail = `${nextDetail.slice(0, THINKING_ACTIVITY_HEAD_CHARS)}${THINKING_ACTIVITY_TRUNCATION_MARKER}${nextDetail.slice(-THINKING_ACTIVITY_TAIL_CHARS)}`;
    return {
      detail,
      fullCharCount,
      persistedCharCount: detail.length,
      truncated: true,
    };
  }

  const markerIndex = input.detail.indexOf(THINKING_ACTIVITY_TRUNCATION_MARKER);
  const head =
    markerIndex >= 0
      ? input.detail.slice(0, markerIndex)
      : input.detail.slice(0, THINKING_ACTIVITY_HEAD_CHARS);
  const tail =
    markerIndex >= 0
      ? input.detail.slice(markerIndex + THINKING_ACTIVITY_TRUNCATION_MARKER.length)
      : input.detail.slice(-THINKING_ACTIVITY_TAIL_CHARS);
  const detail = `${head}${THINKING_ACTIVITY_TRUNCATION_MARKER}${`${tail}${input.delta}`.slice(-THINKING_ACTIVITY_TAIL_CHARS)}`;
  return {
    detail,
    fullCharCount,
    persistedCharCount: detail.length,
    truncated: true,
  };
}

function applyThinkingDelta(
  state: ThinkingStreamState,
  event: ThinkingActivityDeltaEvent,
): ThinkingStreamState {
  const threadActivities = state.activitiesByThreadId[event.threadId] ?? {};
  const existingActivity = threadActivities[event.activityId];
  const existingPayload =
    existingActivity?.payload && typeof existingActivity.payload === "object"
      ? (existingActivity.payload as Record<string, unknown>)
      : {};
  const existingDetail =
    typeof existingPayload.detail === "string"
      ? existingPayload.detail
      : (existingActivity?.summary ?? "");
  const nextPayload = appendThinkingDetail({
    detail: existingDetail,
    delta: event.delta,
    fullCharCount:
      typeof existingPayload.fullCharCount === "number"
        ? Math.max(0, existingPayload.fullCharCount)
        : existingDetail.length,
    truncated: existingPayload.truncated === true,
  });
  const nextActivity: OrchestrationThreadActivity = {
    id: event.activityId,
    tone: "thinking",
    kind: thinkingActivityKind(event.streamKind),
    summary: thinkingActivitySummary(event.streamKind),
    payload: {
      detail: nextPayload.detail,
      streamKind: event.streamKind,
      fullCharCount: nextPayload.fullCharCount,
      persistedCharCount: nextPayload.persistedCharCount,
      truncated: nextPayload.truncated,
    },
    turnId: event.turnId,
    createdAt: existingActivity?.createdAt ?? event.createdAt,
  };

  return {
    activitiesByThreadId: {
      ...state.activitiesByThreadId,
      [event.threadId]: {
        ...threadActivities,
        [event.activityId]: nextActivity,
      },
    },
  };
}

function reconcilePersistedActivities(
  state: ThinkingStreamState,
  events: ReadonlyArray<OrchestrationEvent>,
): ThinkingStreamState {
  let nextState = state;

  for (const event of events) {
    if (event.type === "thread.activity-appended") {
      const currentThreadActivities = nextState.activitiesByThreadId[event.payload.threadId];
      if (!currentThreadActivities || !(event.payload.activity.id in currentThreadActivities)) {
        continue;
      }

      const nextThreadActivities = { ...currentThreadActivities };
      delete nextThreadActivities[event.payload.activity.id];
      nextState = {
        activitiesByThreadId: {
          ...nextState.activitiesByThreadId,
          [event.payload.threadId]: nextThreadActivities,
        },
      };
      continue;
    }

    if (event.type === "thread.deleted") {
      if (!(event.payload.threadId in nextState.activitiesByThreadId)) {
        continue;
      }
      const nextActivitiesByThreadId = { ...nextState.activitiesByThreadId };
      delete nextActivitiesByThreadId[event.payload.threadId];
      nextState = {
        activitiesByThreadId: nextActivitiesByThreadId,
      };
    }
  }

  return nextState;
}

function clearThread(state: ThinkingStreamState, threadId: string): ThinkingStreamState {
  if (!(threadId in state.activitiesByThreadId)) {
    return state;
  }

  const nextActivitiesByThreadId = { ...state.activitiesByThreadId };
  delete nextActivitiesByThreadId[threadId];
  return {
    activitiesByThreadId: nextActivitiesByThreadId,
  };
}

export const useThinkingStreamStore = create<ThinkingStreamStore>((set) => ({
  ...initialState,
  applyThinkingDelta: (event) => set((state) => applyThinkingDelta(state, event)),
  reconcilePersistedActivities: (events) =>
    set((state) => reconcilePersistedActivities(state, events)),
  clearAll: () => set(initialState),
  clearThread: (threadId) => set((state) => clearThread(state, threadId)),
}));
