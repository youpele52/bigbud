import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type OrchestrationReadModel, type ThreadId } from "@bigbud/contracts";

const THREAD_CONTEXTS_DIR_SEGMENT = "thread-contexts";

function toSafeThreadContextFileName(threadId: string): string {
  return threadId.replace(/[\\/:*?"<>|]/g, "-");
}

function formatThreadContextDate(value: string): string {
  try {
    return new Date(value).toISOString();
  } catch {
    return value;
  }
}

export function serializeThreadContextMarkdown(thread: {
  readonly id: ThreadId;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly createdAt: string;
  }>;
}): string {
  const lines: string[] = [
    `# ${thread.title}`,
    "",
    `- Thread ID: ${thread.id}`,
    `- Created: ${formatThreadContextDate(thread.createdAt)}`,
    `- Updated: ${formatThreadContextDate(thread.updatedAt)}`,
    "",
  ];

  for (const message of thread.messages) {
    const roleLabel = message.role.charAt(0).toUpperCase() + message.role.slice(1);
    lines.push(`## ${roleLabel} — ${formatThreadContextDate(message.createdAt)}`);
    lines.push("");
    if (message.text.length > 0) {
      lines.push(message.text);
    } else {
      lines.push("(empty message)");
    }
    lines.push("");
  }

  return lines.join("\n");
}

export interface ExportThreadContextInput {
  readonly threadId: ThreadId;
  readonly snapshot: OrchestrationReadModel;
  readonly stateDir: string;
}

export interface ExportThreadContextFromThreadInput {
  readonly thread: {
    readonly id: ThreadId;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly messages: ReadonlyArray<{
      readonly role: "user" | "assistant" | "system";
      readonly text: string;
      readonly createdAt: string;
    }>;
  };
  readonly stateDir: string;
}

export interface ExportThreadContextResult {
  readonly path: string;
}

export async function exportThreadContextFromThread(
  input: ExportThreadContextFromThreadInput,
): Promise<ExportThreadContextResult> {
  const targetDir = path.join(input.stateDir, THREAD_CONTEXTS_DIR_SEGMENT);
  await mkdir(targetDir, { recursive: true });

  const fileName = `${toSafeThreadContextFileName(input.thread.id)}.md`;
  const filePath = path.join(targetDir, fileName);

  const content = serializeThreadContextMarkdown({
    id: input.thread.id,
    title: input.thread.title,
    createdAt: input.thread.createdAt,
    updatedAt: input.thread.updatedAt,
    messages: input.thread.messages,
  });

  await writeFile(filePath, content, "utf8");

  return { path: filePath };
}

export async function exportThreadContext(
  input: ExportThreadContextInput,
): Promise<ExportThreadContextResult> {
  const thread = input.snapshot.threads.find((entry) => entry.id === input.threadId);
  if (!thread) {
    throw new Error(`Thread '${input.threadId}' not found.`);
  }

  return exportThreadContextFromThread({
    thread: {
      id: thread.id,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messages: thread.messages,
    },
    stateDir: input.stateDir,
  });
}

export function resolveThreadContextPath(input: {
  readonly threadId: ThreadId;
  readonly stateDir: string;
}): string {
  return path.join(
    input.stateDir,
    THREAD_CONTEXTS_DIR_SEGMENT,
    `${toSafeThreadContextFileName(input.threadId)}.md`,
  );
}
