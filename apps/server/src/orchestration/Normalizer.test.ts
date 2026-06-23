import * as OS from "node:os";
import * as path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
  type UploadChatAttachment,
} from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { resolveAttachmentPath } from "../attachments/attachmentStore.ts";
import { ServerConfig } from "../startup/config.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

function runNormalize(command: ClientOrchestrationCommand) {
  return Effect.runPromise(normalizeDispatchCommand(command).pipe(Effect.provide(TestLayer)));
}

function getServerConfig() {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* ServerConfig;
    }).pipe(Effect.provide(TestLayer)),
  );
}

function makeTurnStartCommand(attachments: UploadChatAttachment[]): ClientOrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("cmd-turn"),
    threadId: ThreadId.makeUnsafe("thread-1"),
    message: {
      messageId: MessageId.makeUnsafe("msg-1"),
      role: "user",
      text: "hello",
      attachments,
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("normalizeDispatchCommand", () => {
  it("normalizes local project workspace roots through WorkspacePaths", async () => {
    const normalized = await runNormalize({
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-project-create-local"),
      projectId: ProjectId.makeUnsafe("project-local"),
      title: "Local Project",
      workspaceRoot: "~",
      defaultModelSelection: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(normalized.type).toBe("project.create");
    if (normalized.type !== "project.create") {
      throw new Error(`Unexpected command type: ${normalized.type}`);
    }
    expect(normalized.workspaceRoot).toBe(OS.homedir());
  });

  it("preserves remote project workspace roots without local filesystem normalization", async () => {
    const normalized = await runNormalize({
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-project-create-remote"),
      projectId: ProjectId.makeUnsafe("project-remote"),
      title: "Remote Project",
      executionTargetId: "ssh:devbox",
      workspaceRoot: "~/workspace/bigbud  ",
      defaultModelSelection: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(normalized.type).toBe("project.create");
    if (normalized.type !== "project.create") {
      throw new Error(`Unexpected command type: ${normalized.type}`);
    }
    expect(normalized.workspaceRoot).toBe("~/workspace/bigbud");
  });

  it("preserves explicit remote workspace updates", async () => {
    const normalized = await runNormalize({
      type: "project.meta.update",
      commandId: CommandId.makeUnsafe("cmd-project-update-remote"),
      projectId: ProjectId.makeUnsafe("project-remote"),
      executionTargetId: "ssh:devbox",
      workspaceRoot: "~/workspace/renamed  ",
    });

    expect(normalized.type).toBe("project.meta.update");
    if (normalized.type !== "project.meta.update") {
      throw new Error(`Unexpected command type: ${normalized.type}`);
    }
    expect(normalized.workspaceRoot).toBe("~/workspace/renamed");
  });

  it("hydrates a readable file path-reference attachment into a persisted file attachment", async () => {
    const config = await getServerConfig();
    const noteDir = path.join(config.stateDir, "notes", "project-1");
    await mkdir(noteDir, { recursive: true });
    const notePath = path.join(noteDir, "2026-01-01-12-00-00.md");
    await writeFile(notePath, "# Note content\n\nDetails here.");

    const normalized = await runNormalize(
      makeTurnStartCommand([
        {
          type: "path",
          name: "Note.md",
          mimeType: "text/plain",
          sizeBytes: 0,
          path: notePath,
          entryKind: "file",
        },
      ]),
    );

    expect(normalized.type).toBe("thread.turn.start");
    if (normalized.type !== "thread.turn.start") {
      throw new Error(`Unexpected command type: ${normalized.type}`);
    }
    expect(normalized.message.attachments).toHaveLength(1);
    const attachment = normalized.message.attachments[0];
    expect(attachment).toBeDefined();
    if (!attachment) {
      throw new Error("Attachment is undefined");
    }
    expect(attachment.type).toBe("file");
    if (attachment.type !== "file") {
      throw new Error(`Unexpected attachment type: ${attachment.type}`);
    }
    expect(attachment.name).toBe("Note.md");
    expect(attachment.mimeType).toBe("text/plain");
    expect(attachment.sourcePath).toBe(notePath);
    expect(attachment.sizeBytes).toBeGreaterThan(0);

    const persistedPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment,
    });
    expect(persistedPath).not.toBeNull();
  });

  it("keeps a directory path-reference attachment as type path", async () => {
    const config = await getServerConfig();
    const dirPath = path.join(config.stateDir, "notes", "project-2");
    await mkdir(dirPath, { recursive: true });

    const normalized = await runNormalize(
      makeTurnStartCommand([
        {
          type: "path",
          name: "notes",
          mimeType: "inode/directory",
          sizeBytes: 0,
          path: dirPath,
          entryKind: "directory",
        },
      ]),
    );

    expect(normalized.type).toBe("thread.turn.start");
    if (normalized.type !== "thread.turn.start") {
      throw new Error(`Unexpected command type: ${normalized.type}`);
    }
    expect(normalized.message.attachments).toHaveLength(1);
    const attachment = normalized.message.attachments[0];
    expect(attachment).toBeDefined();
    if (!attachment) {
      throw new Error("Attachment is undefined");
    }
    expect(attachment.type).toBe("path");
    if (attachment.type !== "path") {
      throw new Error(`Unexpected attachment type: ${attachment.type}`);
    }
    expect(attachment.entryKind).toBe("directory");
    expect(attachment.path).toBe(dirPath);
  });

  it("keeps a missing file path-reference attachment as type path", async () => {
    const config = await getServerConfig();
    const missingPath = path.join(config.stateDir, "notes", "missing.md");

    const normalized = await runNormalize(
      makeTurnStartCommand([
        {
          type: "path",
          name: "missing.md",
          mimeType: "text/plain",
          sizeBytes: 0,
          path: missingPath,
          entryKind: "file",
        },
      ]),
    );

    expect(normalized.type).toBe("thread.turn.start");
    if (normalized.type !== "thread.turn.start") {
      throw new Error(`Unexpected command type: ${normalized.type}`);
    }
    expect(normalized.message.attachments).toHaveLength(1);
    const attachment = normalized.message.attachments[0];
    expect(attachment).toBeDefined();
    expect(attachment?.type).toBe("path");
  });

  it("keeps a relative path-reference attachment as type path", async () => {
    const normalized = await runNormalize(
      makeTurnStartCommand([
        {
          type: "path",
          name: "relative.md",
          mimeType: "text/plain",
          sizeBytes: 0,
          path: "notes/project/relative.md",
          entryKind: "file",
        },
      ]),
    );

    expect(normalized.type).toBe("thread.turn.start");
    if (normalized.type !== "thread.turn.start") {
      throw new Error(`Unexpected command type: ${normalized.type}`);
    }
    expect(normalized.message.attachments).toHaveLength(1);
    const attachment = normalized.message.attachments[0];
    expect(attachment).toBeDefined();
    expect(attachment?.type).toBe("path");
  });
});
