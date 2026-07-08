import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createPiOrchestrationBridge } from "./PiOrchestrationBridge.ts";
import { renderPiOrchestrationBridgeSource } from "./PiOrchestrationBridge.template.ts";
import { readThreadOrchestrationToolAuth } from "./ThreadOrchestrationToolAuth.ts";

describe("PiOrchestrationBridge", () => {
  it("renders rename and archive tools that call the internal thread-tools endpoint", () => {
    const source = renderPiOrchestrationBridgeSource({
      host: "127.0.0.1",
      port: 3773,
      threadId: "thread-1",
      token: "token-1",
    });

    expect(source).toContain('name: "rename_thread"');
    expect(source).toContain('name: "archive_thread"');
    expect(source).toContain('name: "get_thread_status"');
    expect(source).toContain('name: "update_plan"');
    expect(source).toContain('name: "computer_use"');
    expect(source).toContain("/api/internal/thread-tools");
    expect(source).toContain("token-1");
  });

  it("renders JavaScript-safe Pi bridge source", () => {
    const source = renderPiOrchestrationBridgeSource({
      host: "127.0.0.1",
      port: 3773,
      threadId: "thread-1",
      token: "token-1",
    });

    expect(source).not.toContain("type ExtensionAPI");
    expect(source).not.toContain(" as const");
    expect(source).not.toContain("message: string");
    expect(source).toContain("export default function bigbudOrchestrationBridge(pi) {");
  });

  it("writes a Pi extension and per-thread auth record", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "bigbud-pi-orchestration-auth-"));
    const bridge = await createPiOrchestrationBridge({
      stateDir,
      threadId: "thread-1",
      host: "127.0.0.1",
      port: 3773,
    });

    try {
      expect(bridge.extraArgs).toEqual(["--extension", bridge.extensionPath]);
      const auth = await readThreadOrchestrationToolAuth({
        stateDir,
        threadId: "thread-1",
      });
      expect(auth?.threadId).toBe("thread-1");
    } finally {
      await bridge.cleanup();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
