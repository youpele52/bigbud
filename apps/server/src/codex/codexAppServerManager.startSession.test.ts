import { describe, expect, it, vi } from "vitest";

import { hasReadyMcpServers, waitForMcpServersReady } from "./codexAppServerManager.ts";

describe("Codex MCP startup readiness", () => {
  it("detects when expected MCP servers have loaded tools", () => {
    expect(
      hasReadyMcpServers(
        {
          servers: [
            {
              name: "bigbud_orchestration",
              startupStatus: "ready",
              tools: [{ name: "rename_thread" }],
            },
          ],
        },
        ["bigbud_orchestration"],
      ),
    ).toBe(true);
    expect(
      hasReadyMcpServers(
        {
          servers: [
            {
              name: "bigbud_orchestration",
              startupStatus: "starting",
              tools: [],
            },
          ],
        },
        ["bigbud_orchestration"],
      ),
    ).toBe(false);
  });

  it("continues Codex startup when MCP status probing times out", async () => {
    const emitLifecycleEvent = vi.fn();

    await expect(
      waitForMcpServersReady(
        {} as never,
        {
          emitLifecycleEvent,
          sendRequest: vi
            .fn()
            .mockRejectedValue(new Error("Timed out waiting for mcpServerStatus/list.")),
        },
        ["bigbud_orchestration"],
      ),
    ).resolves.toBeUndefined();

    expect(emitLifecycleEvent).toHaveBeenCalledWith(
      {},
      "session/mcpStatusUnavailable",
      "Timed out waiting for mcpServerStatus/list.",
    );
  });

  it("does not treat a failed server with a nonempty tool catalog as ready", () => {
    expect(
      hasReadyMcpServers(
        {
          servers: [
            {
              name: "bigbud_remote_workspace",
              startupStatus: "failed",
              tools: [{ name: "bash" }],
            },
            {
              name: "bigbud_remote_workspace",
              startupStatus: "ready",
              tools: [{ name: "bash" }],
            },
          ],
        },
        ["bigbud_remote_workspace"],
      ),
    ).toBe(false);
  });
});
