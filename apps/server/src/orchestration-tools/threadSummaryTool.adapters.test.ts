import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexThreadOrchestrationDynamicToolHandler } from "./codexThreadDynamicTools.ts";
import { createCodexThreadOrchestrationDynamicTools } from "./codexThreadDynamicTools.specs.ts";
import { createCopilotOrchestrationToolSurface } from "../provider/Layers/Copilot/Adapter.session.orchestrationTools.ts";
import {
  setThreadOrchestrationToolDispatcher,
  type ThreadOrchestrationToolDispatcherShape,
} from "./ThreadOrchestrationToolDispatcher.ts";
import { SET_ELEVATOR_SUMMARY_TOOL_PARAMETERS } from "./threadSummaryTool.shared.ts";

const caller = ThreadId.makeUnsafe("summary-caller");
const source = MessageId.makeUnsafe("summary-source");
const invalid = [
  { summary: "own", threadId: "foreign" },
  { summary: "own", targetThreadId: "foreign" },
  { summary: "own", callerThreadId: "foreign" },
  { summary: 1 },
  {},
];
function harness() {
  const setElevatorSummary = vi.fn(
    (
      input: Parameters<
        NonNullable<ThreadOrchestrationToolDispatcherShape["setElevatorSummary"]>
      >[0],
    ) => Effect.succeed({ summary: input.summary }),
  );
  const dispatcher = { setElevatorSummary } as unknown as ThreadOrchestrationToolDispatcherShape;
  return { setElevatorSummary, dispatcher };
}
afterEach(() => setThreadOrchestrationToolDispatcher(null));

it("Codex exposes summary-only arguments and binds caller/source/request identity", async () => {
  const { dispatcher, setElevatorSummary } = harness();
  setThreadOrchestrationToolDispatcher(dispatcher);
  expect(
    createCodexThreadOrchestrationDynamicTools().find(
      (tool) => tool.name === "set_elevator_summary",
    )?.inputSchema,
  ).toEqual(SET_ELEVATOR_SUMMARY_TOOL_PARAMETERS);
  const handler = createCodexThreadOrchestrationDynamicToolHandler(caller, source);
  const call = (args: Record<string, unknown>) =>
    handler({
      namespace: "bigbud_orchestration",
      tool: "set_elevator_summary",
      requestId: 17,
      arguments: args,
    });
  await call({ summary: "Own summary" });
  expect(setElevatorSummary).toHaveBeenCalledExactlyOnceWith({
    threadId: caller,
    summary: "Own summary",
    invocationId: "17",
    sourceMessageId: source,
  });
  for (const args of invalid) await expect(call(args)).rejects.toThrow();
  expect(setElevatorSummary).toHaveBeenCalledOnce();
  setThreadOrchestrationToolDispatcher({} as ThreadOrchestrationToolDispatcherShape);
  await expect(call({ summary: "Own summary" })).rejects.toThrow("not ready");
});

it("Copilot binds summary to its session caller and trusted tool call, rejecting targets", async () => {
  const { dispatcher, setElevatorSummary } = harness();
  const tool = createCopilotOrchestrationToolSurface({ dispatcher, threadId: caller }).find(
    (candidate) => candidate.name === "set_elevator_summary",
  )!;
  expect(tool.parameters).toEqual(SET_ELEVATOR_SUMMARY_TOOL_PARAMETERS);
  const invocation = {
    toolCallId: "summary-call",
    toolName: tool.name,
    sessionId: "native",
    arguments: {},
  };
  await tool.handler!({ summary: "Own summary" }, invocation);
  expect(setElevatorSummary).toHaveBeenCalledExactlyOnceWith({
    threadId: caller,
    summary: "Own summary",
    invocationId: "summary-call",
    sourceMessageId: "summary-call",
  });
  for (const args of invalid) {
    expect(await tool.handler!(args, invocation)).toMatchObject({ resultType: "failure" });
  }
  expect(setElevatorSummary).toHaveBeenCalledOnce();
});
