import { expect, it } from "vitest";
import { renderPiOrchestrationBridgeSource } from "./PiOrchestrationBridge.template.ts";
import {
  renderOpencodeOrchestrationBridgeFiles,
  OPENCODE_ORCHESTRATION_TOOL_FILES,
} from "./opencodeThreadOrchestrationTools.ts";

const config = { host: "127.0.0.1", port: 3773, threadId: "owner", token: "fixture" };
it("registers Pi publication with provider invocation identity", () => {
  const source = renderPiOrchestrationBridgeSource(config);
  expect(source).toContain("name: 'render_html'");
  expect(source).toContain("action: 'render_html', htmlArguments: args, invocationId: toolCallId");
});
it("includes legacy OpenCode publication in emitted files and managed inventory", () => {
  const files = renderOpencodeOrchestrationBridgeFiles(config);
  expect(OPENCODE_ORCHESTRATION_TOOL_FILES).toHaveProperty(".opencode/tools/render_html.ts");
  expect(files[".opencode/tools/render_html.ts"]).toContain(
    "context.sessionID, context.messageID, context.callID",
  );
  expect(files[".bigbud/opencode-orchestration-runtime.ts"]).toContain(
    "action: 'render_html', htmlArguments, invocationId",
  );
});
