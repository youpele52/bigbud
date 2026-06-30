import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { prepareAcpThreadOrchestrationBridge } from "./orchestrationMcpBridge.session.ts";

describe("orchestrationMcpBridge.session", () => {
  it("prepares an ACP MCP bridge that exposes computer_use", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "bigbud-acp-bridge-"));
    const prepared = await prepareAcpThreadOrchestrationBridge({
      stateDir,
      threadId: "thread-acp-bridge",
      host: "127.0.0.1",
      port: 3773,
    });

    try {
      expect(prepared.mcpServers).toEqual([
        {
          name: "bigbud_orchestration",
          command: process.execPath,
          args: [prepared.bridge.serverPath],
          env: [],
        },
      ]);

      const source = await fs.readFile(prepared.bridge.serverPath, "utf8");
      expect(source).toContain("computer_use");
      expect(source).toContain("/api/internal/thread-tools");
    } finally {
      await prepared.bridge.cleanup();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
