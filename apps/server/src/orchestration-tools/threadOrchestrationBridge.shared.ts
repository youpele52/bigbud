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
