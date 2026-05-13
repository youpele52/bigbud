/**
 * CopilotAdapter types, interfaces, constants, and pure helper functions.
 *
 * @module CopilotAdapter.types
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  EventId,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
} from "@bigbud/contracts";
import {
  type CopilotClientOptions,
  type CopilotSession,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionEvent,
} from "@github/copilot-sdk";

import { type EventNdjsonLogger } from "../EventNdjsonLogger.ts";
import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../../Services/ProviderAdapter.ts";

export const PROVIDER = "copilot" as const;
export const DEFAULT_BINARY_PATH = "copilot";
export const USER_INPUT_QUESTION_ID = "answer";

export interface PendingApprovalRequest {
  readonly request: PermissionRequest;
  readonly requestType:
    | "command_execution_approval"
    | "file_change_approval"
    | "file_read_approval"
    | "browser_approval"
    | "dynamic_tool_call"
    | "unknown";
  readonly turnId: TurnId | undefined;
  readonly resolve: (result: PermissionRequestResult) => void;
}

export interface PendingUserInputRequest {
  readonly turnId: TurnId | undefined;
  readonly choices: ReadonlyArray<string>;
  readonly resolve: (result: CopilotUserInputResponse) => void;
}

export interface CopilotUserInputRequest {
  readonly question: string;
  readonly choices?: ReadonlyArray<string>;
  readonly allowFreeform?: boolean;
}

export interface CopilotUserInputResponse {
  readonly answer: string;
  readonly wasFreeform: boolean;
}

export interface MutableTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

export interface ActiveCopilotSession {
  readonly client: import("@github/copilot-sdk").CopilotClient;
  session: CopilotSession;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly pendingApprovals: Map<string, PendingApprovalRequest>;
  readonly pendingUserInputs: Map<string, PendingUserInputRequest>;
  readonly turns: Array<MutableTurnSnapshot>;
  /** Creates a fresh session to replace a stale one (e.g. after server restart). */
  readonly renewSession: () => Promise<CopilotSession>;
  unsubscribe: () => void;
  cwd: string | undefined;
  model: string | undefined;
  updatedAt: string;
  lastError: string | undefined;
  activeTurnId: TurnId | undefined;
  activeMessageId: string | undefined;
  lastUsage: ThreadTokenUsageSnapshot | undefined;
  /**
   * Set to `true` by `stopSessionRecord` so that any in-flight auto-approve
   * timers can bail out early instead of calling into a torn-down session.
   */
  stopped: boolean;
}

export interface CopilotAdapterLiveOptions {
  readonly clientFactory?: (
    options: CopilotClientOptions,
  ) => import("@github/copilot-sdk").CopilotClient;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

/**
 * Resolves the path to the bundled @github/copilot index.js CLI entry point.
 */
function resolveCopilotCliPath(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const sdkMain = req.resolve("@github/copilot-sdk");
    const sdkMainDir = dirname(sdkMain);
    for (const githubDir of [
      join(sdkMainDir, "..", "..", ".."), // dist/cjs/index.js -> @github/
      join(sdkMainDir, "..", ".."), //       dist/index.js     -> @github/
    ]) {
      const candidate = join(githubDir, "copilot", "index.js");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * When running inside Electron, returns a shell wrapper CLI path that invokes
 * the copilot CLI via the real `node` binary rather than the Electron binary.
 * Returns `undefined` when not in Electron or when the CLI path cannot be resolved.
 */
export function makeNodeWrapperCliPath(): string | undefined {
  if (!("electron" in process.versions)) return undefined;
  const cliPath = resolveCopilotCliPath();
  if (!cliPath) return undefined;
  const wrapperPath = join(tmpdir(), `copilot-node-wrapper-${randomUUID()}.sh`);
  writeFileSync(wrapperPath, `#!/bin/sh\nexec node ${JSON.stringify(cliPath)} "$@"\n`, "utf8");
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

/** Returns true when the Copilot CLI reports the session ID no longer exists (e.g. after a server restart). */
export function isSessionNotFoundError(cause: unknown): boolean {
  return cause instanceof Error && cause.message.toLowerCase().includes("session not found");
}

export function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function toRuntimeItemId(value: string | undefined): RuntimeItemId | undefined {
  return value ? RuntimeItemId.makeUnsafe(value) : undefined;
}

export function toRuntimeRequestId(value: string | undefined): RuntimeRequestId | undefined {
  return value ? RuntimeRequestId.makeUnsafe(value) : undefined;
}

export function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value ? ProviderItemId.makeUnsafe(value) : undefined;
}

export function normalizeUsage(
  event: Extract<SessionEvent, { type: "assistant.usage" }>,
): ThreadTokenUsageSnapshot {
  const inputTokens = event.data.inputTokens ?? 0;
  const outputTokens = event.data.outputTokens ?? 0;
  const cachedInputTokens = event.data.cacheReadTokens ?? 0;
  const usedTokens = inputTokens + outputTokens + cachedInputTokens;

  return {
    usedTokens,
    totalProcessedTokens: usedTokens,
    ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens > 0
      ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
      : {}),
    ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    ...(usedTokens > 0 ? { lastUsedTokens: usedTokens } : {}),
    ...(typeof event.data.duration === "number" ? { durationMs: event.data.duration } : {}),
  };
}

export function buildThreadSnapshot(
  threadId: ThreadId,
  turns: ReadonlyArray<MutableTurnSnapshot>,
): ProviderThreadSnapshot {
  return {
    threadId,
    turns: turns.map<ProviderThreadTurnSnapshot>((turn) => ({
      id: turn.id,
      items: [...turn.items],
    })),
  };
}

export function eventBase(input: {
  eventId: EventId;
  createdAt: string;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
  raw?: ProviderRuntimeEvent["raw"];
}): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const providerTurnId = input.turnId;
  const providerItemId = toProviderItemId(input.itemId);
  const providerRequestId = normalizeString(input.requestId);

  return {
    eventId: input.eventId,
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: toRuntimeItemId(input.itemId) } : {}),
    ...(input.requestId ? { requestId: toRuntimeRequestId(input.requestId) } : {}),
    ...(providerTurnId || providerItemId || providerRequestId
      ? {
          providerRefs: {
            ...(providerTurnId ? { providerTurnId } : {}),
            ...(providerItemId ? { providerItemId } : {}),
            ...(providerRequestId ? { providerRequestId } : {}),
          },
        }
      : {}),
    ...(input.raw ? { raw: input.raw } : {}),
  };
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

export function isCopilotModelSelection(
  value: unknown,
): value is Extract<
  NonNullable<import("@bigbud/contracts").ProviderSendTurnInput["modelSelection"]>,
  { provider: "copilot" }
> {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    value.provider === "copilot" &&
    "model" in value &&
    typeof value.model === "string"
  );
}
