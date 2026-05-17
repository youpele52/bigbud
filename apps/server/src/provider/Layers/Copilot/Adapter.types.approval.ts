import { type PermissionRequest, type PermissionRequestResult } from "@github/copilot-sdk";

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export interface CopilotSessionApprovalMetadata {
  readonly available: boolean;
  readonly label?: string;
}

export function requestTypeFromPermissionRequest(request: PermissionRequest) {
  switch (request.kind) {
    case "shell":
      return "command_execution_approval" as const;
    case "write":
      return "file_change_approval" as const;
    case "read":
      return "file_read_approval" as const;
    case "mcp": {
      const props = request as unknown as Record<string, unknown>;
      const toolName = String(props.toolName ?? "").toLowerCase();
      if (
        toolName.includes("browser") ||
        toolName.includes("navigate") ||
        toolName.includes("screenshot")
      ) {
        return "browser_approval" as const;
      }
      return "dynamic_tool_call" as const;
    }
    case "custom-tool":
    case "url":
    case "memory":
    case "hook":
      return "dynamic_tool_call" as const;
    default:
      return "unknown" as const;
  }
}

export function requestDetailFromPermissionRequest(request: PermissionRequest): string | undefined {
  const props = request as unknown as Record<string, unknown>;

  switch (request.kind) {
    case "shell":
      return normalizeString(props.fullCommandText as string | undefined);
    case "write":
      return (
        normalizeString(props.fileName as string | undefined) ??
        normalizeString(props.intention as string | undefined)
      );
    case "read":
      return (
        normalizeString(props.path as string | undefined) ??
        normalizeString(props.intention as string | undefined)
      );
    case "mcp":
      return (
        normalizeString(props.toolTitle as string | undefined) ??
        normalizeString(props.toolName as string | undefined)
      );
    case "url":
      return normalizeString(props.url as string | undefined);
    case "custom-tool":
      return (
        normalizeString(props.toolName as string | undefined) ??
        normalizeString(props.toolDescription as string | undefined)
      );
    case "memory":
      return (
        normalizeString(props.subject as string | undefined) ??
        normalizeString(props.fact as string | undefined)
      );
    case "hook":
      return (
        normalizeString(props.hookMessage as string | undefined) ??
        normalizeString(props.toolName as string | undefined)
      );
    default:
      return undefined;
  }
}

function getCopilotSessionApproval(
  request: PermissionRequest,
):
  | Exclude<
      PermissionRequestResult,
      | { kind: "no-result" }
      | { kind: "approve-once" }
      | { kind: "reject" }
      | { kind: "user-not-available" }
    >
  | undefined {
  const props = request as unknown as Record<string, unknown>;

  switch (request.kind) {
    case "shell": {
      if (props.canOfferSessionApproval !== true || !Array.isArray(props.commands)) {
        return undefined;
      }

      const commandIdentifiers = props.commands.flatMap((command) => {
        if (typeof command !== "object" || command === null || !("identifier" in command)) {
          return [];
        }
        return typeof command.identifier === "string" && command.identifier.length > 0
          ? [command.identifier]
          : [];
      });
      if (commandIdentifiers.length === 0) {
        return undefined;
      }

      return {
        kind: "approve-for-session",
        approval: {
          kind: "commands",
          commandIdentifiers,
        },
      };
    }
    case "write":
      return props.canOfferSessionApproval === true
        ? {
            kind: "approve-for-session",
            approval: {
              kind: "write",
            },
          }
        : undefined;
    case "read":
      return {
        kind: "approve-for-session",
        approval: {
          kind: "read",
        },
      };
    case "mcp": {
      const serverName = normalizeString(props.serverName);
      if (!serverName) {
        return undefined;
      }

      return {
        kind: "approve-for-session",
        approval: {
          kind: "mcp",
          serverName,
          toolName: normalizeString(props.toolName) ?? null,
        },
      };
    }
    case "custom-tool": {
      const toolName = normalizeString(props.toolName);
      if (!toolName) {
        return undefined;
      }

      return {
        kind: "approve-for-session",
        approval: {
          kind: "custom-tool",
          toolName,
        },
      };
    }
    case "memory":
      return {
        kind: "approve-for-session",
        approval: {
          kind: "memory",
        },
      };
    default:
      return undefined;
  }
}

export function getCopilotSessionApprovalMetadata(
  request: PermissionRequest,
): CopilotSessionApprovalMetadata {
  switch (request.kind) {
    case "shell": {
      const approval = getCopilotSessionApproval(request);
      return {
        available: approval !== undefined,
        ...(approval !== undefined ? { label: "Allow matching commands this session" } : {}),
      };
    }
    case "write":
      return {
        available: getCopilotSessionApproval(request) !== undefined,
        label: "Allow writes this session",
      };
    case "read":
      return {
        available: true,
        label: "Allow reads this session",
      };
    case "mcp":
      return {
        available: getCopilotSessionApproval(request) !== undefined,
        label: "Allow this MCP tool this session",
      };
    case "custom-tool":
      return {
        available: getCopilotSessionApproval(request) !== undefined,
        label: "Allow this tool this session",
      };
    case "memory":
      return {
        available: true,
        label: "Allow memory actions this session",
      };
    default:
      return {
        available: false,
      };
  }
}

export function approvalDecisionToPermissionResult(
  decision: import("@bigbud/contracts").ProviderApprovalDecision,
  request: PermissionRequest,
): PermissionRequestResult {
  switch (decision) {
    case "accept":
      return { kind: "approve-once" };
    case "acceptForSession":
      return getCopilotSessionApproval(request) ?? { kind: "approve-once" };
    case "decline":
    case "cancel":
    default:
      return { kind: "reject" };
  }
}
