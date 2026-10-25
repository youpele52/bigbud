import type { TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ActivePiSession } from "./Adapter.types.ts";
import type { PiRpcStdoutMessage } from "./RpcProcess.types.ts";
import { extractTextContent, isRecord } from "./Adapter.utils.ts";

interface QueuedInput {
  readonly text: string;
  readonly sequence: number;
  turnId?: TurnId;
}

export interface PiPromptQueueState {
  sequence: number;
  steering: QueuedInput[];
  followUp: QueuedInput[];
  consumed: QueuedInput[];
  lastAdded?: QueuedInput;
}

/** Follow Pi's canonical queue, which contains expanded templates and transformed input. */
export function trackPiPromptQueue(session: ActivePiSession, message: PiRpcStdoutMessage) {
  if (!session.process.supportsAgentSettled) return;
  const state = (session.promptQueue ??= { sequence: 0, steering: [], followUp: [], consumed: [] });
  if (message.type === "queue_update") {
    for (const lane of ["steering", "followUp"] as const) {
      const next = message[lane] ?? [];
      const removals = new Map<string, number>();
      for (const entry of state[lane])
        removals.set(entry.text, (removals.get(entry.text) ?? 0) + 1);
      for (const text of next) removals.set(text, (removals.get(text) ?? 0) - 1);
      // Pi removes the first matching occurrence. Preserve ownership when an extension and
      // a user prompt happen to enqueue identical text (or two templates expand identically).
      const remaining = state[lane].filter((entry) => {
        const count = removals.get(entry.text) ?? 0;
        if (count <= 0) return true;
        removals.set(entry.text, count - 1);
        state.consumed.push(entry);
        return false;
      });
      state[lane] = next.map((text) => {
        const index = remaining.findIndex((entry) => entry.text === text);
        if (index !== -1) return remaining.splice(index, 1)[0]!;
        const entry = { text, sequence: ++state.sequence };
        state.lastAdded = entry;
        return entry;
      });
    }
  } else if (message.type === "response" && message.success && message.command === "prompt") {
    const turnId = [...(session.pendingPromptTurnIds ?? [])].find((id) => id === message.id);
    if (!turnId) return;
    const disposition = isRecord(message.data) ? message.data.disposition : undefined;
    // 0.80.4–0.98.x acknowledge preflight without a disposition. A new canonical queue
    // append during this queued request supplies the missing acceptance evidence.
    const legacyQueued =
      session.process.supportsPromptDisposition === false &&
      disposition === undefined &&
      session.queuedTurnIds.includes(turnId) &&
      (state.lastAdded?.sequence ?? 0) > (session.pendingPromptQueueStarts?.get(turnId) ?? 0);
    session.pendingPromptQueueStarts?.delete(turnId);
    // Pi emits the queue append before its authoritative prompt response. Extension-created
    // entries remain unowned; only the append acknowledged by this request belongs to the turn.
    if ((disposition === "queued" || legacyQueued) && state.lastAdded) {
      state.lastAdded.turnId = turnId;
      delete state.lastAdded;
    }
  } else if (message.type === "message_start" && message.message?.role === "user") {
    const text = extractTextContent(message.message);
    const index = state.consumed.findIndex((entry) => entry.text === text);
    if (index === -1) return;
    const [entry] = state.consumed.splice(index, 1);
    if (!entry?.turnId) return;
    const turnId = entry.turnId;
    session.pendingPromptTurnIds?.delete(turnId);
    if (session.activeTurnId && session.activeTurnId !== turnId) {
      (session.settlingTurnIds ??= new Set()).add(session.activeTurnId);
    }
    session.activeTurnId = turnId;
    const queued = session.queuedTurnIds.indexOf(turnId);
    if (queued !== -1) session.queuedTurnIds.splice(queued, 1);
  }
}
