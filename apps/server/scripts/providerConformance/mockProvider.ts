/**
 * Scripted mock provider for the conformance self-test (WP-5D). It never contacts a model.
 * It reads the row from the fixed prompt's `(row)` marker and emits the canonical events a real
 * provider turn produces: assistant messages, tool/approval/question activities and
 * `thread.turn-settled`. Self-test results are never acceptance evidence.
 */
import { randomUUID } from "node:crypto";

export interface MockTurnHost {
  readonly append: (threadId: string, type: string, payload: Record<string, unknown>) => void;
  readonly files: ReadonlyMap<string, string>;
  /** Resolves with the client's response to a request id. */
  readonly awaitResponse: (requestId: string) => Promise<unknown>;
  readonly isInterrupted: (threadId: string) => boolean;
  readonly stepMs: number;
  readonly ignoreInterrupt: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TOKEN = /BBCONF-[0-9A-F]{8}/u;

export const QUESTION = {
  id: "colour",
  header: "Colour",
  question: "Which colour should be used?",
  options: [
    { label: "blue", description: "Blue" },
    { label: "green", description: "Green" },
  ],
};

function decodeAttachment(attachments: ReadonlyArray<unknown>): string {
  const first = attachments[0] as { dataUrl?: string } | undefined;
  const base64 = first?.dataUrl?.split(",")[1] ?? "";
  return Buffer.from(base64, "base64").toString("utf8").trim();
}

export async function runMockTurn(
  host: MockTurnHost,
  input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly text: string;
    readonly attachments: ReadonlyArray<unknown>;
  },
): Promise<void> {
  const { threadId, turnId } = input;
  const row = /\((\w+)\)/u.exec(input.text)?.[1] ?? "text";
  const messageId = `mock-assistant-${randomUUID()}`;
  const activity = (kind: string, payload: Record<string, unknown> = {}) =>
    host.append(threadId, "thread.activity-appended", {
      threadId,
      activity: {
        id: randomUUID(),
        tone: "info",
        kind,
        summary: kind,
        payload,
        turnId,
        createdAt: new Date().toISOString(),
      },
    });
  const message = (text: string, streaming: boolean) =>
    host.append(threadId, "thread.message-sent", {
      threadId,
      messageId,
      role: "assistant",
      text,
      turnId,
      streaming,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  const settle = (outcome: string) =>
    host.append(threadId, "thread.turn-settled", {
      threadId,
      turnId,
      outcome,
      sessionEpoch: 0,
      completedAt: new Date().toISOString(),
    });
  const request = async (requested: string, payload: Record<string, unknown>) => {
    const requestId = randomUUID();
    activity(requested, { requestId, ...payload });
    return { requestId, response: await host.awaitResponse(requestId) };
  };

  await sleep(host.stepMs);
  switch (row) {
    case "attachment":
      message(decodeAttachment(input.attachments), false);
      return settle("completed");
    case "tool":
      activity("tool.started", { itemType: "command_execution" });
      await sleep(host.stepMs);
      activity("tool.completed", { itemType: "command_execution" });
      message(host.files.get("bigbud-conformance-tool.txt")?.trim() ?? "", false);
      return settle("completed");
    case "approval": {
      const { requestId } = await request("approval.requested", { requestKind: "command" });
      activity("approval.resolved", { requestId });
      activity("tool.completed", { itemType: "command_execution" });
      message(host.files.get("bigbud-conformance-approval.txt")?.trim() ?? "", false);
      return settle("completed");
    }
    case "question": {
      const { requestId, response } = await request("user-input.requested", {
        questions: [QUESTION],
      });
      activity("user-input.resolved", { requestId });
      const answers = (response ?? {}) as Record<string, unknown>;
      message(String(answers[QUESTION.id] ?? ""), false);
      return settle("completed");
    }
    case "cancel":
      for (let line = 1; line <= 500; line += 1) {
        if (host.isInterrupted(threadId) && !host.ignoreInterrupt) return settle("interrupted");
        message(`${line}\n`, true);
        await sleep(host.stepMs);
      }
      return settle("completed");
    case "replay":
      for (let index = 1; index <= 10; index += 1) {
        message(`${index} `, true);
        await sleep(host.stepMs);
      }
      message(TOKEN.exec(input.text)?.[0] ?? "", true);
      return settle("completed");
    default:
      message(TOKEN.exec(input.text)?.[0] ?? "", false);
      return settle("completed");
  }
}
