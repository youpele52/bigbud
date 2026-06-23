import { type ThreadId } from "@bigbud/contracts";

export const BIGBUD_THREAD_CONTEXT_DRAG_MIME = "application/x-bigbud-thread-context";

export interface ThreadContextDragPayload {
  threadId: ThreadId;
  title: string;
}

export function serializeThreadContextDragPayload(payload: ThreadContextDragPayload): string {
  return JSON.stringify(payload);
}

export function parseThreadContextDragPayload(value: string): ThreadContextDragPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<ThreadContextDragPayload>;
    if (
      typeof parsed.threadId !== "string" ||
      parsed.threadId.length === 0 ||
      typeof parsed.title !== "string" ||
      parsed.title.length === 0
    ) {
      return null;
    }
    return {
      threadId: parsed.threadId,
      title: parsed.title,
    };
  } catch {
    return null;
  }
}
