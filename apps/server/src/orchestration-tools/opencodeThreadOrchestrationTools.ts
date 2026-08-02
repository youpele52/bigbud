import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LIST_THREADS_MAX_LIMIT } from "./ThreadOrchestrationTools.listThreads.ts";
import {
  ARCHIVE_THREAD_TOOL_DESCRIPTION,
  GET_THREAD_STATUS_TOOL_DESCRIPTION,
  LIST_THREADS_TOOL_DESCRIPTION,
  RENAME_THREAD_TOOL_DESCRIPTION,
  SEND_THREAD_MESSAGE_TOOL_DESCRIPTION,
  renderCallOrchestrationToolSource,
  renderResolveCurrentThreadIdSource,
  renderThreadOrchestrationConfigLiteral,
  type ThreadOrchestrationHttpConfig,
} from "./threadOrchestrationBridge.shared.ts";
import {
  READ_CAPABILITY_GUIDE_TOOL_DESCRIPTION,
  SEARCH_CAPABILITIES_TOOL_DESCRIPTION,
} from "./capabilityCatalogTool.shared.ts";

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
    "  async execute(args, context) {",
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

export function renderOpencodeSendThreadMessageToolSource(): string {
  return renderOrchestrationToolSource({
    description: SEND_THREAD_MESSAGE_TOOL_DESCRIPTION,
    argsSource: [
      '    threadId: tool.schema.string().describe("Target thread ID"),',
      '    message: tool.schema.string().describe("Follow-up message"),',
      '    delivery: tool.schema.enum(["auto", "queue"]).optional(),',
    ].join("\n"),
    executeBody: [
      "const result = await runtime.sendThreadMessage({ ...args, invocationId: `opencode:${context.sessionID}:${context.messageID}:${String(args.threadId ?? '')}:${String(args.message ?? '')}` });",
      "return result.message;",
    ],
  });
}

export function renderOpencodeListThreadsToolSource(): string {
  return renderOrchestrationToolSource({
    description: LIST_THREADS_TOOL_DESCRIPTION,
    argsSource: [
      '    projectId: tool.schema.string().optional().describe("Project ID; defaults to the current project"),',
      '    status: tool.schema.enum(["active", "archived", "all"]).optional().describe("Thread status filter; defaults to active"),',
      `    limit: tool.schema.number().optional().describe("Maximum threads to return (max ${LIST_THREADS_MAX_LIMIT})"),`,
      '    includeExcerpt: tool.schema.boolean().optional().describe("Include a short excerpt of each thread\'s last assistant message"),',
    ].join("\n"),
    executeBody: ["const result = await runtime.listThreads(args);", "return result.message;"],
  });
}

export function renderOpencodeSearchCapabilitiesToolSource(): string {
  return renderOrchestrationToolSource({
    description: SEARCH_CAPABILITIES_TOOL_DESCRIPTION,
    argsSource: [
      '    query: tool.schema.string().optional().describe("Task or keywords to match"),',
    ].join("\n"),
    executeBody: [
      "const result = await runtime.searchCapabilities({",
      "  query: String(args.query ?? ''),",
      "});",
      "return result.message;",
    ],
  });
}

export function renderOpencodeReadCapabilityGuideToolSource(): string {
  return renderOrchestrationToolSource({
    description: READ_CAPABILITY_GUIDE_TOOL_DESCRIPTION,
    argsSource: [
      '    capabilityId: tool.schema.string().describe("Capability ID or logical Track URI"),',
      '    section: tool.schema.enum(["summary", "workflow", "permissions", "examples", "full"]).optional(),',
    ].join("\n"),
    executeBody: [
      "const result = await runtime.readCapabilityGuide({",
      "  capabilityId: String(args.capabilityId ?? ''),",
      "  section: args.section ? String(args.section) : undefined,",
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
    "export async function sendThreadMessage(input) {",
    "  const threadId = String(input.threadId ?? '').trim();",
    "  const message = String(input.message ?? '').trim();",
    "  if (!threadId || !message) throw new Error('Thread ID and message are required.');",
    "  const result = await callOrchestrationTool({ action: 'send_thread_message', threadId, message, delivery: input.delivery === 'queue' ? 'queue' : 'auto', invocationId: input.invocationId });",
    "  return { message: JSON.stringify(result.result ?? {}, null, 2) };",
    "}",
    "",
    "export async function listThreads(input) {",
    "  const projectId = String(input.projectId ?? '').trim();",
    "  const result = await callOrchestrationTool({",
    "    action: 'list_threads',",
    "    ...(projectId ? { projectId } : {}),",
    "    ...(input.status ? { status: input.status } : {}),",
    "    ...(Number.isFinite(input.limit) ? { limit: Number(input.limit) } : {}),",
    "    includeExcerpt: input.includeExcerpt === true,",
    "  });",
    "  return { message: JSON.stringify(result.result ?? {}, null, 2) };",
    "}",
    "",
    "export async function searchCapabilities(input) {",
    "  const result = await callOrchestrationTool({",
    "    action: 'search_capabilities',",
    "    query: input.query,",
    "  });",
    "  return { message: JSON.stringify(result.result ?? {}, null, 2) };",
    "}",
    "",
    "export async function readCapabilityGuide(input) {",
    "  const capabilityId = input.capabilityId.trim();",
    "  if (capabilityId.length === 0) throw new Error('Capability ID is required.');",
    "  const result = await callOrchestrationTool({",
    "    action: 'read_capability_guide',",
    "    capabilityId,",
    "    ...(input.section ? { section: input.section } : {}),",
    "  });",
    "  return { message: JSON.stringify(result.result ?? {}, null, 2) };",
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
      path.join(toolsDir, "send_thread_message.ts"),
      renderOpencodeSendThreadMessageToolSource(),
      "utf8",
    ),
    writeFile(
      path.join(toolsDir, "list_threads.ts"),
      renderOpencodeListThreadsToolSource(),
      "utf8",
    ),
    writeFile(
      path.join(toolsDir, "search_capabilities.ts"),
      renderOpencodeSearchCapabilitiesToolSource(),
      "utf8",
    ),
    writeFile(
      path.join(toolsDir, "read_capability_guide.ts"),
      renderOpencodeReadCapabilityGuideToolSource(),
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
  ".opencode/tools/send_thread_message.ts": renderOpencodeSendThreadMessageToolSource,
  ".opencode/tools/list_threads.ts": renderOpencodeListThreadsToolSource,
  ".opencode/tools/search_capabilities.ts": renderOpencodeSearchCapabilitiesToolSource,
  ".opencode/tools/read_capability_guide.ts": renderOpencodeReadCapabilityGuideToolSource,
} as const;

export function renderOpencodeOrchestrationBridgeFiles(
  input: ThreadOrchestrationHttpConfig,
): Record<string, string> {
  return {
    ".opencode/tools/rename_thread.ts": renderOpencodeRenameThreadToolSource(),
    ".opencode/tools/archive_thread.ts": renderOpencodeArchiveThreadToolSource(),
    ".opencode/tools/get_thread_status.ts": renderOpencodeGetThreadStatusToolSource(),
    ".opencode/tools/send_thread_message.ts": renderOpencodeSendThreadMessageToolSource(),
    ".opencode/tools/list_threads.ts": renderOpencodeListThreadsToolSource(),
    ".opencode/tools/search_capabilities.ts": renderOpencodeSearchCapabilitiesToolSource(),
    ".opencode/tools/read_capability_guide.ts": renderOpencodeReadCapabilityGuideToolSource(),
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
