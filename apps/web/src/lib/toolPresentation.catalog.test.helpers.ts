import { readFileSync } from "node:fs";
import * as ts from "typescript";

/** Read production declarations without importing server services, SDKs, generators or plugin code. */
function source(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(new URL(`../../../server/src/${path}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

export function registeredToolNames(...paths: string[]): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText() === "name" &&
        ts.isStringLiteral(node.initializer)
      )
        names.add(node.initializer.text);
      if (ts.isStringLiteral(node)) {
        for (const match of node.text.matchAll(/\bname:\s*["']([a-z][a-z0-9_]*)["']/g))
          names.add(match[1]!);
      }
      ts.forEachChild(node, visit);
    };
    visit(source(path));
  }
  if (names.size === 0)
    throw new Error(`No production tool registrations found in ${paths.join(", ")}`);
  return [...names].toSorted();
}

export function declaredStrings(path: string, variable: string): string[] {
  let values: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === variable && node.initializer) {
      const initializer = ts.isAsExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (ts.isArrayLiteralExpression(initializer))
        values = initializer.elements.filter(ts.isStringLiteral).map((item) => item.text);
      if (ts.isStringLiteral(initializer)) values = [initializer.text];
    }
    ts.forEachChild(node, visit);
  };
  visit(source(path));
  if (values.length === 0) throw new Error(`Missing production declaration ${path}#${variable}`);
  return values;
}

const workspace = "orchestration-tools/AgentWorkspaceToolSpecs.ts";
const browser = "orchestration-tools/orchestrationBrowserTool.shared.ts";
const computer = "orchestration-tools/orchestrationComputerUseTool.shared.ts";
const plan = declaredStrings(
  "orchestration-tools/threadPlanTrackingTool.shared.ts",
  "BIGBUD_PLAN_TRACKING_TOOL_NAME",
);

export const ownedToolCatalogs = {
  codex: registeredToolNames("orchestration-tools/codexThreadDynamicTools.specs.ts", workspace),
  mcp: registeredToolNames(
    "orchestration-tools/orchestrationMcpBridge.template.shared.ts",
    workspace,
  ),
  copilot: [
    ...registeredToolNames(
      "orchestration-tools/copilotThreadOrchestrationTools.ts",
      "orchestration-tools/copilotThreadOrchestrationTools.threads.ts",
      workspace,
    ),
    ...plan,
  ],
  pi: [
    ...registeredToolNames(
      "orchestration-tools/PiOrchestrationBridge.template.ts",
      browser,
      computer,
      workspace,
    ),
    ...plan,
  ],
  native: registeredToolNames("provider/Layers/OpencodeV2/Orchestration.plugin.specs.ts"),
  coding: declaredStrings("provider/Layers/OpencodeV2/Coding.plugin.ts", "V2_CODING_TOOLS"),
  remote: declaredStrings(
    "remote-workspace-bridge/remoteWorkspaceTools.ts",
    "REMOTE_WORKSPACE_TOOL_NAMES",
  ),
};

export const browserActions = declaredStrings(browser, "BROWSER_ACTION_ENUM");
export const computerActions = declaredStrings(computer, "COMPUTER_USE_ACTION_ENUM");
