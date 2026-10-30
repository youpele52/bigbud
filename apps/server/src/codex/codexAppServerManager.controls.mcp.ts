import type { McpServerStatusEntry } from "@bigbud/contracts/orchestration/providerRuntime.mcp.ts";
import { readObject, readString } from "./codexAppServerManager.protocol.ts";
import { CodexReadBudget, readCodexPage } from "./codexAppServerManager.pagination.ts";
import type { CodexSessionContext } from "./codexAppServerManager.types.ts";
import type { TurnOps } from "./codexAppServerManager.turn.ts";
import { redactMcpText } from "../provider/providerMcp.ts";

/** Allowlist neutral state only: never forward config, URLs, tools, server metadata or error text. */
export async function readCodexMcpStatus(
  context: CodexSessionContext,
  nativeThreadId: string,
  ops: Pick<TurnOps, "sendRequest">,
  assertCurrent: () => void,
): Promise<ReadonlyArray<McpServerStatusEntry>> {
  const budget = new CodexReadBudget({
    pages: 20,
    records: 1000,
    bytes: 4 * 1024 * 1024,
    timeoutMs: 20_000,
  });
  const cursors = new Set<string>();
  const names = new Set<string>();
  const servers: McpServerStatusEntry[] = [];
  let cursor: string | null = null;
  do {
    assertCurrent();
    const page = readCodexPage(
      await ops.sendRequest(
        context,
        "mcpServerStatus/list",
        {
          threadId: nativeThreadId,
          cursor,
          limit: 100,
          detail: "toolsAndAuthOnly",
        },
        budget.remainingMs(),
      ),
      cursors,
      budget,
    );
    assertCurrent();
    if (page.nextCursor && page.nextCursor.length > 4096) throw new Error("Invalid MCP cursor.");
    for (const entry of page.data) {
      const record = readObject(entry);
      const name = readString(record, "name");
      if (
        !name ||
        name.trim() !== name ||
        name.length > 512 ||
        Array.from(name).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        names.has(name)
      )
        throw new Error("Invalid MCP server identity.");
      const safeName = redactMcpText(name);
      if (safeName.length > 512 || names.has(safeName))
        throw new Error("Invalid redacted MCP server identity.");
      names.add(safeName);
      const runtime = readString(record, "runtimeStatus");
      const status: McpServerStatusEntry["status"] =
        runtime === "connected"
          ? "connected"
          : runtime === "authenticationRequired"
            ? "needs-auth"
            : runtime === "disabled"
              ? "disabled"
              : runtime === "failed" || runtime === "cancelled"
                ? "failed"
                : "pending";
      servers.push({ name: safeName, status });
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return servers;
}
