import { expect, it } from "vitest";
import { HTML_RENDER_TOOL_DESCRIPTION } from "./htmlRenderTool.shared.ts";
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
it("tells every provider bridge that render_html is never a question channel", () => {
  expect(HTML_RENDER_TOOL_DESCRIPTION).toContain(
    "Never use render_html to ask the user a question or collect input",
  );
  expect(HTML_RENDER_TOOL_DESCRIPTION).toContain(
    "links to http or https URLs open in the user's browser when clicked",
  );
  expect(HTML_RENDER_TOOL_DESCRIPTION).toContain(
    "set background, text colour and color-scheme together on your outer container",
  );
  expect(HTML_RENDER_TOOL_DESCRIPTION).toContain(
    "Never mix your own text colours with bigbud's background",
  );
  const source = renderPiOrchestrationBridgeSource(config);
  expect(source).toContain(JSON.stringify(HTML_RENDER_TOOL_DESCRIPTION));
  const files = renderOpencodeOrchestrationBridgeFiles(config);
  expect(files[".opencode/tools/render_html.ts"]).toContain(
    JSON.stringify(HTML_RENDER_TOOL_DESCRIPTION),
  );
});
