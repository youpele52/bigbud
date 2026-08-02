import { describe, expect, it } from "vitest";

import {
  OPENCODE_ORCHESTRATION_TOOL_FILES,
  renderOpencodeListThreadsToolSource,
  renderOpencodeOrchestrationRuntimeSource,
  renderOpencodeReadCapabilityGuideToolSource,
  renderOpencodeRenameThreadToolSource,
  renderOpencodeSearchCapabilitiesToolSource,
  renderOpencodeSendThreadMessageToolSource,
} from "./opencodeThreadOrchestrationTools.ts";

describe("opencodeThreadOrchestrationTools", () => {
  it("renders JavaScript-safe OpenCode thread tool sources", () => {
    const toolSource = renderOpencodeRenameThreadToolSource();
    const searchToolSource = renderOpencodeSearchCapabilitiesToolSource();
    const readToolSource = renderOpencodeReadCapabilityGuideToolSource();
    const runtimeSource = renderOpencodeOrchestrationRuntimeSource({
      host: "127.0.0.1",
      port: 3773,
      threadId: "thread-1",
      token: "token-1",
    });
    const sendToolSource = renderOpencodeSendThreadMessageToolSource();

    expect(toolSource).not.toContain("readonly");
    expect(runtimeSource).not.toContain(" as {");
    expect(runtimeSource).not.toContain(" as const");
    expect(runtimeSource).not.toContain("input: {");
    expect(runtimeSource).toContain("export async function renameThread(input) {");
    expect(runtimeSource).toContain("export async function getThreadStatus(input) {");
    expect(runtimeSource).toContain("export async function searchCapabilities(input) {");
    expect(runtimeSource).toContain("export async function readCapabilityGuide(input) {");
    expect(searchToolSource).toContain("runtime.searchCapabilities");
    expect(readToolSource).toContain("runtime.readCapabilityGuide");
    expect(sendToolSource).toContain("context.sessionID");
    expect(sendToolSource).toContain("context.messageID");
    expect(sendToolSource).toContain('tool.schema.enum(["auto", "queue"]).optional()');
    expect(sendToolSource).not.toContain("randomUUID");
    expect(runtimeSource).toContain("export async function sendThreadMessage(input) {");
    expect(runtimeSource).toContain("delivery: input.delivery === 'queue' ? 'queue' : 'auto'");
    expect(runtimeSource).toContain('"threadId": "thread-1"');
    expect(runtimeSource).toContain("token-1");
  });

  it("renders and registers the list_threads tool", () => {
    const listToolSource = renderOpencodeListThreadsToolSource();
    const runtimeSource = renderOpencodeOrchestrationRuntimeSource({
      host: "127.0.0.1",
      port: 3773,
      threadId: "thread-1",
      token: "token-1",
    });

    expect(listToolSource).toContain("runtime.listThreads(args)");
    expect(listToolSource).toContain('tool.schema.enum(["active", "archived", "all"]).optional()');
    expect(listToolSource).not.toContain("readonly");
    expect(runtimeSource).toContain("export async function listThreads(input) {");
    expect(runtimeSource).toContain("action: 'list_threads'");
    expect(OPENCODE_ORCHESTRATION_TOOL_FILES).toHaveProperty(
      ".opencode/tools/list_threads.ts",
      renderOpencodeListThreadsToolSource,
    );
  });
});
