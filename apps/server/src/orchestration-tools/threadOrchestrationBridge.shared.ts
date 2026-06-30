import {
  createThreadOrchestrationToolToken,
  writeThreadOrchestrationToolAuth,
} from "./ThreadOrchestrationToolAuth.ts";

export interface ThreadOrchestrationHttpConfig {
  readonly host: string;
  readonly port: number;
  readonly threadId: string;
  readonly token: string;
}

export interface ThreadOrchestrationSessionBridgeInput {
  readonly stateDir: string;
  readonly threadId: string;
  readonly host: string | undefined;
  readonly port: number;
}

export const THREAD_ORCHESTRATION_API_PATH = "/api/internal/thread-tools";

export const RENAME_THREAD_TOOL_DESCRIPTION = "Rename the current BigBud thread.";

export const ARCHIVE_THREAD_TOOL_DESCRIPTION = "Archive the current BigBud thread.";

export const GET_THREAD_STATUS_TOOL_DESCRIPTION =
  "Get live workflow status for a BigBud thread in the current project. Use this to check whether another thread's agent is still working before starting dependent work.";

export const COMPUTER_USE_TOOL_DESCRIPTION =
  'Automate the in-app browser and native desktop apps via the `computer_use` tool. Use `surface: "browser"` for browser navigation, clicks, typing, and screenshots. Use `surface: "desktop"` for native macOS automation such as launching or focusing apps, reading Calendar or Reminders, capturing screens, and interacting through the accessibility tree. Do not assume CLI tools or direct app APIs are unavailable before trying this tool. Read-only actions (capture, get_page_info, list_windows, list_apps, check_permissions, doctor, get_accessibility_tree) work in any runtime mode. Mutating actions require full-access runtime mode.';

export function resolveOrchestrationBridgeHost(host: string | undefined): string {
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "127.0.0.1";
  }
  return host;
}

export async function prepareThreadOrchestrationSessionAuth(
  input: Pick<ThreadOrchestrationSessionBridgeInput, "stateDir" | "threadId">,
): Promise<{ readonly token: string }> {
  const token = createThreadOrchestrationToolToken();
  await writeThreadOrchestrationToolAuth({
    stateDir: input.stateDir,
    threadId: input.threadId,
    token,
  });
  return { token };
}

export function resolveThreadOrchestrationHttpConfig(
  input: ThreadOrchestrationSessionBridgeInput,
  token: string,
): ThreadOrchestrationHttpConfig {
  return {
    host: resolveOrchestrationBridgeHost(input.host),
    port: input.port,
    threadId: input.threadId,
    token,
  };
}

export function renderThreadOrchestrationConfigLiteral(
  config: ThreadOrchestrationHttpConfig,
): string {
  return JSON.stringify(config, null, 2);
}

export function renderCallOrchestrationToolSource(typed: boolean): string {
  const payloadType = typed ? " as { readonly message?: string; readonly title?: string }" : "";
  return [
    "async function callOrchestrationTool(body: Record<string, unknown>) {",
    `  const response = await fetch(\`http://\${CONFIG.host}:\${CONFIG.port}${THREAD_ORCHESTRATION_API_PATH}\`, {`,
    "    method: 'POST',",
    "    headers: {",
    "      'content-type': 'application/json',",
    "      'x-bigbud-thread-tool-token': CONFIG.token,",
    "    },",
    "    body: JSON.stringify(body),",
    "  });",
    `  const payload = (await response.json().catch(() => ({})))${payloadType};`,
    "  if (!response.ok) {",
    "    const message =",
    "      typeof payload?.message === 'string'",
    "        ? payload.message",
    "        : `Thread tool failed with status ${response.status}.`;",
    "    throw new Error(message);",
    "  }",
    "  return payload;",
    "}",
  ].join("\n");
}

export function renderResolveCurrentThreadIdSource(): string {
  return ["function resolveCurrentThreadId() {", "  return CONFIG.threadId;", "}"].join("\n");
}
