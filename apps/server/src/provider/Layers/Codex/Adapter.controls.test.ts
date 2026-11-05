import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { CodexAppServerManager } from "../../../codex/codexAppServerManager.ts";
import { makeCodexControls } from "./Adapter.controls.ts";

it("rejects targeted MCP operations without calling any native method", async () => {
  const providerControls = vi.fn();
  const { mcp } = makeCodexControls(
    { providerControls } as unknown as CodexAppServerManager,
    () => undefined,
  );
  const threadId = ThreadId.makeUnsafe("chat");
  for (const operation of [
    mcp.reconnect(threadId, "server"),
    mcp.toggle(threadId, "server", true),
    mcp.replace(threadId, { secret: {} }),
  ]) {
    await expect(Effect.runPromise(operation)).rejects.toThrow("unavailable");
  }
  expect(providerControls).not.toHaveBeenCalled();
});
