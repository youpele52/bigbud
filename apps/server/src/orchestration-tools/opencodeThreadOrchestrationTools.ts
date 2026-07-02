import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ARCHIVE_THREAD_TOOL_DESCRIPTION,
  GET_THREAD_STATUS_TOOL_DESCRIPTION,
  RENAME_THREAD_TOOL_DESCRIPTION,
  renderCallOrchestrationToolSource,
  renderResolveCurrentThreadIdSource,
  renderThreadOrchestrationConfigLiteral,
  type ThreadOrchestrationHttpConfig,
} from "./threadOrchestrationBridge.shared.ts";

function renderOrchestrationToolSource(input: {
  readonly description: string;
  readonly argsSource: string;
  readonly executeBody: ReadonlyArray<string>;
}): string {
  return [
    'import { tool } from "@opencode-ai/plugin";',
    'import * as runtime from "../../.bigbud/opencode-orchestration-runtime.ts";',
    "",
    "export default tool({",
    `  description: ${JSON.stringify(input.description)},`,
    "  args: {",
    input.argsSource,
    "  },",
    "  async execute(args) {",
    ...input.executeBody.map((line) => `    ${line}`),
    "  },",
    "});",
  ].join("\n");
}

export function renderOpencodeRenameThreadToolSource(): string {
  return renderOrchestrationToolSource({
    description: RENAME_THREAD_TOOL_DESCRIPTION,
    argsSource: ['    title: tool.schema.string().describe("New thread title"),'].join("\n"),
    executeBody: [
      "const result = await runtime.renameThread({",
      "  title: String(args.title ?? ''),",
      "});",
      "return result.message;",
    ],
  });
}

export function renderOpencodeArchiveThreadToolSource(): string {
  return renderOrchestrationToolSource({
    description: ARCHIVE_THREAD_TOOL_DESCRIPTION,
    argsSource: "",
    executeBody: ["const result = await runtime.archiveThread();", "return result.message;"],
  });
}

export function renderOpencodeGetThreadStatusToolSource(): string {
  return renderOrchestrationToolSource({
    description: GET_THREAD_STATUS_TOOL_DESCRIPTION,
    argsSource: ['    threadId: tool.schema.string().describe("Thread ID to inspect"),'].join("\n"),
    executeBody: [
      "const result = await runtime.getThreadStatus({",
      "  threadId: String(args.threadId ?? ''),",
      "});",
      "return result.message;",
    ],
  });
}

export function renderOpencodeOrchestrationRuntimeSource(
  input: ThreadOrchestrationHttpConfig,
): string {
  const config = renderThreadOrchestrationConfigLiteral(input);
  return [
    `const CONFIG = ${config};`,
    "",
    renderCallOrchestrationToolSource(),
    "",
    renderResolveCurrentThreadIdSource(),
    "",
    "export async function renameThread(input) {",
    "  const title = input.title.trim();",
    "  if (title.length === 0) throw new Error('Thread title cannot be empty.');",
    "  const result = await callOrchestrationTool({",
    "    action: 'rename',",
    "    threadId: resolveCurrentThreadId(),",
    "    title,",
    "  });",
    '  return { message: `Renamed thread to "${result.title ?? title}".` };',
    "}",
    "",
    "export async function archiveThread() {",
    "  await callOrchestrationTool({ action: 'archive', threadId: resolveCurrentThreadId() });",
    "  return { message: 'Archived the current thread.' };",
    "}",
    "",
    "export async function getThreadStatus(input) {",
    "  const threadId = input.threadId.trim();",
    "  if (threadId.length === 0) throw new Error('Thread ID is required.');",
    "  const result = await callOrchestrationTool({ action: 'get_status', threadId });",
    "  return { message: JSON.stringify(result.status ?? {}, null, 2) };",
    "}",
    "",
  ].join("\n");
}

export interface OpencodeOrchestrationToolWorkspace {
  readonly targetDir: string;
  readonly cleanup: () => Promise<void>;
}

export async function writeOpencodeOrchestrationTools(input: {
  readonly targetDir: string;
  readonly host: string;
  readonly port: number;
  readonly threadId: string;
  readonly token: string;
}): Promise<void> {
  const toolsDir = path.join(input.targetDir, ".opencode", "tools");
  const runtimeDir = path.join(input.targetDir, ".bigbud");
  const httpConfig: ThreadOrchestrationHttpConfig = {
    host: input.host,
    port: input.port,
    threadId: input.threadId,
    token: input.token,
  };
  await mkdir(toolsDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(toolsDir, "rename_thread.ts"),
      renderOpencodeRenameThreadToolSource(),
      "utf8",
    ),
    writeFile(
      path.join(toolsDir, "archive_thread.ts"),
      renderOpencodeArchiveThreadToolSource(),
      "utf8",
    ),
    writeFile(
      path.join(toolsDir, "get_thread_status.ts"),
      renderOpencodeGetThreadStatusToolSource(),
      "utf8",
    ),
    writeFile(
      path.join(runtimeDir, "opencode-orchestration-runtime.ts"),
      renderOpencodeOrchestrationRuntimeSource(httpConfig),
      "utf8",
    ),
  ]);
}

export const OPENCODE_ORCHESTRATION_TOOL_FILES = {
  ".opencode/tools/rename_thread.ts": renderOpencodeRenameThreadToolSource,
  ".opencode/tools/archive_thread.ts": renderOpencodeArchiveThreadToolSource,
  ".opencode/tools/get_thread_status.ts": renderOpencodeGetThreadStatusToolSource,
} as const;

export function renderOpencodeOrchestrationBridgeFiles(
  input: ThreadOrchestrationHttpConfig,
): Record<string, string> {
  return {
    ".opencode/tools/rename_thread.ts": renderOpencodeRenameThreadToolSource(),
    ".opencode/tools/archive_thread.ts": renderOpencodeArchiveThreadToolSource(),
    ".opencode/tools/get_thread_status.ts": renderOpencodeGetThreadStatusToolSource(),
    ".bigbud/opencode-orchestration-runtime.ts": renderOpencodeOrchestrationRuntimeSource(input),
  };
}

export async function createOpencodeOrchestrationToolWorkspace(): Promise<OpencodeOrchestrationToolWorkspace> {
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "bigbud-opencode-orchestration-"));
  return {
    targetDir,
    cleanup: async () => {
      await rm(targetDir, { recursive: true, force: true });
    },
  };
}
