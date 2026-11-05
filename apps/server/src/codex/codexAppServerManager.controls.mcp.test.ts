import { describe, expect, it, vi } from "vitest";
import { readCodexMcpStatus } from "./codexAppServerManager.controls.mcp.ts";
import { codexProviderControls } from "./codexAppServerManager.controls.ts";
import {
  codexReliabilityHarness,
  exactRewindInput,
} from "./codexAppServerManager.reliability.test.helpers.ts";
import { CodexRpcError } from "./codexAppServerManager.errors.ts";
import type { TurnOps } from "./codexAppServerManager.turn.ts";

describe("redacted native MCP controls", () => {
  it("redacts credentials even from a configured server name", async () => {
    const test = codexReliabilityHarness();
    const sendRequest = vi.fn().mockResolvedValue({
      data: [
        { name: "https://user:password@example.test token=secret", runtimeStatus: "connected" },
      ],
      nextCursor: null,
    });
    const result = await readCodexMcpStatus(test.context, "native", { sendRequest }, () => {});
    expect(result[0]?.name).toBe("[redacted-url] token=[redacted]");
    expect(JSON.stringify(result)).not.toContain("password");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("retains reload uncertainty when its mandatory status refresh also fails", async () => {
    const test = codexReliabilityHarness();
    const base = test.ops.sendRequest;
    const methods: string[] = [];
    const ops = {
      ...test.ops,
      sendRequest: (async (ctx, method, params, timeout) => {
        methods.push(method);
        if (method === "thread/read") return base(ctx, method, params, timeout);
        throw new CodexRpcError(method, 2, "possibly-applied", "private");
      }) as TurnOps["sendRequest"],
    };
    const result = await codexProviderControls(
      test.context,
      { threadId: exactRewindInput.threadId, sessionEpoch: 2, action: "reload-mcp" },
      ops,
      () => true,
    );
    expect(methods).toEqual(["thread/read", "config/mcpServer/reload", "mcpServerStatus/list"]);
    expect(result.reloadState).toBe("unknown");
    expect(result.servers).toBeUndefined();
    expect(result.message).toContain("partially applied");
    expect(result.message).toContain("status refresh failed");
  });
  it("reads all bounded pages in the current native thread context, dropping every non-neutral field", async () => {
    const test = codexReliabilityHarness();
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            name: "first",
            runtimeStatus: "connected",
            serverInfo: { version: "secret" },
            env: { TOKEN: "secret" },
            toolsError: "secret",
            tools: { secret: {} },
          },
        ],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        data: [{ name: "second", runtimeStatus: "authenticationRequired" }],
        nextCursor: null,
      });
    const result = await readCodexMcpStatus(test.context, "native", { sendRequest }, () => {});
    expect(result).toEqual([
      { name: "first", status: "connected" },
      { name: "second", status: "needs-auth" },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(sendRequest.mock.calls.map((call) => call[2])).toEqual([
      { threadId: "native", cursor: null, limit: 100, detail: "toolsAndAuthOnly" },
      { threadId: "native", cursor: "next", limit: 100, detail: "toolsAndAuthOnly" },
    ]);
  });
  it.each([undefined, 42, "", "x".repeat(4097)])(
    "rejects corrupt cursor %s",
    async (nextCursor) => {
      const test = codexReliabilityHarness();
      const sendRequest = vi.fn().mockResolvedValue({ data: [{ name: "one" }], nextCursor });
      await expect(
        readCodexMcpStatus(test.context, "native", { sendRequest }, () => {}),
      ).rejects.toThrow();
    },
  );
  it.each(["repeated", "empty", "duplicate", "malformed"])("rejects %s pages", async (kind) => {
    const test = codexReliabilityHarness();
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ name: "one" }], nextCursor: "next" })
      .mockResolvedValue({
        data:
          kind === "empty"
            ? []
            : [{ name: kind === "duplicate" ? "one" : kind === "malformed" ? "" : "two" }],
        nextCursor: kind === "repeated" || kind === "empty" ? "next" : null,
      });
    await expect(
      readCodexMcpStatus(test.context, "native", { sendRequest }, () => {}),
    ).rejects.toThrow();
  });
  it("enforces the aggregate page budget", async () => {
    const test = codexReliabilityHarness();
    let page = 0;
    const sendRequest = vi.fn(async () => ({
      data: [{ name: `s${++page}` }],
      nextCursor: `p${page}`,
    }));
    await expect(
      readCodexMcpStatus(
        test.context,
        "native",
        { sendRequest: sendRequest as TurnOps["sendRequest"] },
        () => {},
      ),
    ).rejects.toThrow("budget");
    expect(sendRequest).toHaveBeenCalledTimes(21);
  });
  it.each(["notStarted", "starting", "disabled", "failed", "cancelled", null])(
    "does not infer connected from %s",
    async (runtimeStatus) => {
      const test = codexReliabilityHarness();
      const sendRequest = vi.fn().mockResolvedValue({
        data: [{ name: "server", runtimeStatus, authStatus: "oAuth" }],
        nextCursor: null,
      });
      const result = await readCodexMcpStatus(test.context, "native", { sendRequest }, () => {});
      expect(result[0]?.status).not.toBe("connected");
    },
  );
  it.each([true, false])(
    "refreshes status even after reload all fails=%s, retaining the error",
    async (fails) => {
      const test = codexReliabilityHarness();
      const base = test.ops.sendRequest;
      const methods: string[] = [];
      const ops = {
        ...test.ops,
        sendRequest: (async (ctx, method, params, timeout, guard) => {
          methods.push(method);
          if (method === "thread/read") return base(ctx, method, params, timeout);
          if (method === "config/mcpServer/reload") {
            expect(params).toBeUndefined();
            expect(guard?.()).toBe(true);
            if (fails) throw new CodexRpcError(method, 2, "definite-rejection", "TOKEN=private");
            return {};
          }
          return {
            data: [{ name: "server", runtimeStatus: "failed", toolsError: "private" }],
            nextCursor: null,
          };
        }) as TurnOps["sendRequest"],
      };
      const result = await codexProviderControls(
        test.context,
        { threadId: exactRewindInput.threadId, sessionEpoch: 2, action: "reload-mcp" },
        ops,
        () => true,
      );
      expect(methods).toEqual(["thread/read", "config/mcpServer/reload", "mcpServerStatus/list"]);
      expect(result.reloadState).toBe(fails ? "failed" : "completed");
      expect(result.servers).toEqual([{ name: "server", status: "failed" }]);
      expect(result.message?.includes("partially")).toBe(fails ? true : undefined);
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );
  it("discards pages on ownership loss", async () => {
    const test = codexReliabilityHarness();
    let calls = 0;
    const sendRequest = vi.fn().mockResolvedValue({ data: [], nextCursor: null });
    await expect(
      readCodexMcpStatus(test.context, "native", { sendRequest }, () => {
        if (++calls > 1) throw new Error("replaced");
      }),
    ).rejects.toThrow("replaced");
  });
});
