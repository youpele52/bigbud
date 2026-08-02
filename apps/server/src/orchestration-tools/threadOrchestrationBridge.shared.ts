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
  readonly serverName?: string;
}

export const THREAD_ORCHESTRATION_API_PATH = "/api/internal/thread-tools";

export const RENAME_THREAD_TOOL_DESCRIPTION = "Rename the current BigBud thread.";

export const ARCHIVE_THREAD_TOOL_DESCRIPTION = "Archive the current BigBud thread.";

export const CREATE_THREAD_TOOL_DESCRIPTION =
  "Create a standalone bigbud thread in a project and optionally watch it for completion.";

export const GET_THREAD_STATUS_TOOL_DESCRIPTION =
  "Get live workflow status for a BigBud thread in the current project. Use this to check whether another thread's agent is still working before starting dependent work.";

export const SEND_THREAD_MESSAGE_TOOL_DESCRIPTION =
  "Send a follow-up message to an existing bigbud thread. Starts it when safely idle or queues it durably while busy.";

export const LIST_PINNED_THREADS_TOOL_DESCRIPTION =
  "List pinned bigbud threads globally across all projects. This is read-only.";

export const LIST_THREADS_TOOL_DESCRIPTION =
  "List the bigbud threads in a project with their live workflow status. Defaults to the current project and to threads that are not archived. This is read-only. Results are ordered by most recently updated and are capped, so check hasMore before reporting a total.";

export const PIN_THREAD_TOOL_DESCRIPTION =
  "Pin a bigbud thread globally. Only use this when the user explicitly asks to pin a thread.";

export const UNPIN_THREAD_TOOL_DESCRIPTION =
  "Unpin a bigbud thread globally. Only use this when the user explicitly asks to unpin a thread.";

export const BROWSER_TOOL_DESCRIPTION =
  'Control bigbud\'s built-in browsers. Use it by default when capability context says the bigbud browser is preferred, or whenever the user explicitly requests the bigbud/in-app browser. Decide whether the visible browser or background browser is better for each task: use target "visible" when the user wants to see or interact with the page in the bigbud desktop app, and target "background" for unattended research or parallel browsing. target "auto" reuses an existing visible agent tab when one exists, otherwise uses the background browser. Use get_page_text to read page content; do not attempt script execution or unsupported actions. Use close_tab only when the user explicitly asks to close that tab; it may interrupt another agent currently using the tab. Normal task completion must release control instead of closing tabs. This capability is part of bigbud and does not require desktop automation permission. Use computer_use for an external/system browser when explicitly requested or preferred by capability context.';

export const COMPUTER_USE_TOOL_DESCRIPTION =
  'Automate native desktop apps via the `computer_use` tool. Use `surface: "desktop"` for native macOS automation such as launching or focusing apps, reading Calendar or Reminders, capturing screens, and interacting through the accessibility tree. Desktop `navigate` opens the URL in the OS default browser; use it when the user explicitly requests an external/system browser or capability context says that browser is preferred. Opening does not by itself confirm that the browser is controllable. Use the separate `browser` tool for bigbud\'s built-in browser. Do not assume CLI tools or direct app APIs are unavailable before trying this tool. Read-only actions (capture, list_windows, list_apps, check_permissions, doctor, get_accessibility_tree) work in any runtime mode. Mutating actions require full-access runtime mode.';

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

export function renderCallOrchestrationToolSource(): string {
  return [
    "async function callOrchestrationTool(body) {",
    `  const response = await fetch(\`http://\${CONFIG.host}:\${CONFIG.port}${THREAD_ORCHESTRATION_API_PATH}\`, {`,
    "    method: 'POST',",
    "    headers: {",
    "      'content-type': 'application/json',",
    "      'x-bigbud-thread-tool-token': CONFIG.token,",
    "    },",
    "    body: JSON.stringify(body),",
    "  });",
    "  const payload = await response.json().catch(() => ({}));",
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
