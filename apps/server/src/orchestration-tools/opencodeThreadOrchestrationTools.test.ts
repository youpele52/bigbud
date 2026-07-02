import { describe, expect, it } from "vitest";

import {
  renderOpencodeOrchestrationRuntimeSource,
  renderOpencodeRenameThreadToolSource,
} from "./opencodeThreadOrchestrationTools.ts";

describe("opencodeThreadOrchestrationTools", () => {
  it("renders JavaScript-safe OpenCode thread tool sources", () => {
    const toolSource = renderOpencodeRenameThreadToolSource();
    const runtimeSource = renderOpencodeOrchestrationRuntimeSource({
      host: "127.0.0.1",
      port: 3773,
      threadId: "thread-1",
      token: "token-1",
    });

    expect(toolSource).not.toContain("readonly");
    expect(runtimeSource).not.toContain(" as {");
    expect(runtimeSource).not.toContain(" as const");
    expect(runtimeSource).not.toContain("input: {");
    expect(runtimeSource).toContain("export async function renameThread(input) {");
    expect(runtimeSource).toContain("export async function getThreadStatus(input) {");
  });
});
