import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexThreadOrchestrationDynamicToolHandler } from "./codexThreadDynamicTools.ts";
import { createCodexThreadOrchestrationDynamicTools } from "./codexThreadDynamicTools.specs.ts";
import { createCopilotOrchestrationToolSurface } from "../provider/Layers/Copilot/Adapter.session.orchestrationTools.ts";
import {
  setThreadOrchestrationToolDispatcher,
  type ThreadOrchestrationToolDispatcherShape,
} from "./ThreadOrchestrationToolDispatcher.ts";
import { RENAME_THREAD_TOOL_PARAMETERS } from "./threadRenameTool.shared.ts";

const caller = ThreadId.makeUnsafe("canonical-caller");
const target = ThreadId.makeUnsafe("canonical-target");

function harness() {
  const rename = vi.fn((input: Parameters<ThreadOrchestrationToolDispatcherShape["rename"]>[0]) =>
    Effect.succeed({ title: input.title }),
  );
  const dispatcher = { rename } as unknown as ThreadOrchestrationToolDispatcherShape;
  return { rename, dispatcher };
}

afterEach(() => setThreadOrchestrationToolDispatcher(null));

it("routes Codex default and optional-target rename with a fixed caller and trusted invocation identity", async () => {
  const { rename, dispatcher } = harness();
  setThreadOrchestrationToolDispatcher(dispatcher);
  const source = MessageId.makeUnsafe("source");
  const handler = createCodexThreadOrchestrationDynamicToolHandler(caller, source);
  const call = (args: Record<string, unknown>) =>
    handler({
      namespace: "bigbud_orchestration",
      tool: "rename_thread",
      requestId: 7,
      arguments: args,
    });
  expect(
    createCodexThreadOrchestrationDynamicTools().find((tool) => tool.name === "rename_thread")
      ?.inputSchema,
  ).toEqual(RENAME_THREAD_TOOL_PARAMETERS);
  await call({ title: "own" });
  expect(rename).toHaveBeenLastCalledWith({
    threadId: caller,
    title: "own",
    invocationId: "7",
    sourceMessageId: source,
  });
  await call({ title: "other", targetThreadId: target });
  expect(rename).toHaveBeenLastCalledWith({
    threadId: caller,
    targetThreadId: target,
    title: "other",
    invocationId: "7",
    sourceMessageId: source,
  });
  for (const args of [
    { title: "other", targetThreadId: 1 },
    { title: null },
    { title: "other", targetThreadId: " " },
  ]) {
    await expect(call(args)).rejects.toThrow();
  }
  expect(rename).toHaveBeenCalledTimes(2);
});

it("routes Copilot SDK handlers through the same canonical caller/target contract", async () => {
  const { rename, dispatcher } = harness();
  const tool = createCopilotOrchestrationToolSurface({ dispatcher, threadId: caller }).find(
    (tool) => tool.name === "rename_thread",
  )!;
  expect(tool.parameters).toEqual(RENAME_THREAD_TOOL_PARAMETERS);
  const handler = tool.handler;
  if (!handler) throw new Error("Canonical rename fixture handler missing.");
  const invocation = {
    toolCallId: "call-1",
    toolName: "rename_thread",
    sessionId: "native-session",
    arguments: {},
  };
  await handler({ title: "own" }, invocation);
  expect(rename).toHaveBeenLastCalledWith({
    threadId: caller,
    title: "own",
    invocationId: "call-1",
    sourceMessageId: "call-1",
  });
  await handler({ title: "other", targetThreadId: target }, invocation);
  expect(rename).toHaveBeenLastCalledWith({
    threadId: caller,
    targetThreadId: target,
    title: "other",
    invocationId: "call-1",
    sourceMessageId: "call-1",
  });
  for (const args of [
    { title: "other", targetThreadId: null },
    { title: 1 },
    { title: "other", targetThreadId: " " },
  ]) {
    expect(await handler(args as never, invocation)).toMatchObject({ resultType: "failure" });
  }
  expect(rename).toHaveBeenCalledTimes(2);
});
