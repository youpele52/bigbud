import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-10-09T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("v2-attachment-admission");
function readModel(
  provider: "opencodeV2" | "opencode" | "kilocode",
  busy = false,
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.makeUnsafe("project"),
        title: "Preview",
        elevatorSummary: null,
        elevatorSummaryMessageCount: 0,
        modelSelection: { provider, model: "synthetic" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        queuedPrompts: [],
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        pinnedAt: null,
        deletingAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        tasks: [],
        activities: [],
        checkpoints: [],
        watchingThreads: [],
        session: busy
          ? {
              threadId,
              providerName: provider,
              status: "running",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
            }
          : null,
      },
    ],
  };
}
const attachments = [
  { type: "file", id: "upload", name: "file.txt", sizeBytes: 1, mimeType: "text/plain" },
  { type: "image", id: "image", name: "image.png", sizeBytes: 1, mimeType: "image/png" },
  {
    type: "path",
    id: "file-ref",
    name: "file",
    path: "/never/read",
    entryKind: "file",
    sizeBytes: 0,
    mimeType: "text/plain",
  },
  {
    type: "path",
    id: "dir-ref",
    name: "folder",
    path: "/never/list",
    entryKind: "directory",
    sizeBytes: 0,
    mimeType: "inode/directory",
  },
  {
    type: "thread",
    id: "thread-ref",
    name: "context",
    title: "Context",
    threadId: ThreadId.makeUnsafe("never-expand"),
    sizeBytes: 0,
    mimeType: "application/x-bigbud-thread-reference",
  },
] as const;
for (const type of ["thread.turn.start", "thread.message.submit"] as const) {
  for (const busy of [false, true])
    it(`${type} admits V2 attachment kinds through canonical turn/queue events (${busy ? "busy" : "idle"}, legacy omitted model)`, async () => {
      for (const attachment of attachments) {
        const common = {
          commandId: CommandId.makeUnsafe(`reject-${attachment.id}`),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("retained"),
            role: "user" as const,
            text: "retain this",
            attachments: [attachment],
          },
          runtimeMode: "approval-required" as const,
          interactionMode: "default" as const,
          createdAt: now,
        };
        const command: OrchestrationCommand =
          type === "thread.message.submit"
            ? { ...common, type, delivery: "queue" }
            : { ...common, type };
        // Direct start still follows its existing busy-session invariant; queueing remains allowed.
        if (type === "thread.turn.start" && busy) continue;
        const events = await Effect.runPromise(
          decideOrchestrationCommand({ command, readModel: readModel("opencodeV2", busy) }),
        );
        expect(JSON.stringify(events)).toContain(attachment.id);
      }
    });
}

it("does not alter V1/Kilo attachment admission or V2 text queueing", async () => {
  for (const provider of ["opencode", "kilocode", "opencodeV2"] as const) {
    const events = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: readModel(provider),
        command: {
          type: "thread.message.submit",
          commandId: CommandId.makeUnsafe(`allowed-${provider}`),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("message"),
            text: "text coding",
            attachments: [attachments[0]],
          },
          delivery: "queue",
          createdAt: now,
        },
      }),
    );
    expect("type" in events ? events.type : events[0]?.type).toBe("thread.prompt-queued");
  }
});
