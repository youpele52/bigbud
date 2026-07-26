import type { McpServerStatus, McpServerStatusEntry } from "@bigbud/contracts";

const MAX_MCP_TEXT_LENGTH = 512;
const MAX_MCP_STATUS_ENTRIES = 64;
export const MCP_REQUIRED_SERVER_NAMES = ["bigbud_orchestration"] as const;
type UnknownRecord = Record<string, unknown>;

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text.slice(0, MAX_MCP_TEXT_LENGTH) : undefined;
}

/** Removes secrets and transport details before MCP text reaches runtime events. */
export function redactMcpText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, "[redacted-url]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/\b(api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function statusOf(value: unknown): McpServerStatus {
  const status = boundedText(value)?.toLowerCase().replaceAll("_", "-");
  switch (status) {
    case "connected":
    case "needs-auth":
    case "failed":
    case "disabled":
    case "pending":
      return status;
    case "needs-authentication":
    case "auth-required":
      return "needs-auth";
    case "connecting":
    case "loading":
      return "pending";
    case "disconnected":
    case "disabled-by-user":
      return "disabled";
    default:
      return "failed";
  }
}

/** Converts provider-native MCP status entries into bounded canonical state. */
export function normalizeMcpServerStatuses(value: unknown): Array<McpServerStatusEntry> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_MCP_STATUS_ENTRIES).flatMap((entry): Array<McpServerStatusEntry> => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as UnknownRecord;
    const nameValue = boundedText(record.name);
    if (!nameValue) return [];
    const name = redactMcpText(nameValue);
    const messageValue = boundedText(record.error) ?? boundedText(record.message);
    const message = messageValue ? redactMcpText(messageValue) : undefined;
    const versionValue = boundedText(record.version);
    const version = versionValue ? redactMcpText(versionValue) : undefined;
    return [
      {
        name,
        status: statusOf(record.status),
        ...(message ? { message } : {}),
        ...(version ? { version } : {}),
      },
    ];
  });
}

/** Polls only while a required bridge has not reached connected state. */
export function hasUnreadyRequiredMcpStatuses(
  statuses: ReadonlyArray<McpServerStatusEntry>,
  requiredServerNames: ReadonlyArray<string> = MCP_REQUIRED_SERVER_NAMES,
): boolean {
  return requiredServerNames.some(
    (name) => !statuses.some((entry) => entry.name === name && entry.status === "connected"),
  );
}

export function shouldPollRequiredMcpStatuses(
  statuses: ReadonlyArray<McpServerStatusEntry>,
  requiredServerNames: ReadonlyArray<string> = MCP_REQUIRED_SERVER_NAMES,
): boolean {
  return requiredServerNames.some((name) => {
    const status = statuses.find((entry) => entry.name === name)?.status;
    return status === undefined || status === "pending";
  });
}

/** Required bridges block readiness; optional MCP servers never block startup. */
export function mcpReadinessPolicy(
  statuses: ReadonlyArray<McpServerStatusEntry>,
  requiredServerNames: ReadonlyArray<string> = MCP_REQUIRED_SERVER_NAMES,
): { readonly requiredReady: boolean; readonly optionalPending: boolean } {
  return {
    requiredReady: !hasUnreadyRequiredMcpStatuses(statuses, requiredServerNames),
    optionalPending: statuses.some(
      (entry) => !requiredServerNames.includes(entry.name) && entry.status === "pending",
    ),
  };
}

/** Keeps MCP activity payloads free of provider URLs, credentials, and submissions. */
export function redactedMcpRuntimePayload(status: Array<McpServerStatusEntry>): {
  readonly status: Array<McpServerStatusEntry>;
} {
  return { status };
}

export type ProviderMcpAction =
  | { readonly type: "refresh" }
  | { readonly type: "reconnect"; readonly serverName: string }
  | { readonly type: "toggle"; readonly serverName: string; readonly enabled: boolean }
  | { readonly type: "replace"; readonly servers: Readonly<Record<string, unknown>> };

/** Guards the built-in orchestration bridge from user MCP controls. */
export function validateMcpAction(
  action: ProviderMcpAction,
  requiredServerNames: ReadonlyArray<string> = MCP_REQUIRED_SERVER_NAMES,
): { readonly ok: true } | { readonly ok: false; readonly issue: string } {
  if (action.type === "refresh") return { ok: true };
  if (action.type !== "replace" && requiredServerNames.includes(action.serverName)) {
    return {
      ok: false,
      issue: `MCP server '${action.serverName}' is required by bigbud and cannot be changed.`,
    };
  }
  if (action.type !== "replace") return { ok: true };
  const missing = requiredServerNames.filter((name) => !(name in action.servers));
  return missing.length === 0
    ? { ok: true }
    : { ok: false, issue: `MCP replacement must retain required server '${missing[0]}'.` };
}
