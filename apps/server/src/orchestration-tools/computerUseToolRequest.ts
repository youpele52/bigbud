/**
 * One decoder for every computer_use entry point (Codex dynamic tools, Copilot
 * tools and the HTTP route used by Pi and MCP), selected by the pinned Driver
 * release. Under `legacy` it is exactly the previous
 * `Schema.decodeUnknownSync(ComputerUseAction)` (same errors). Under `v2`,
 * browser requests keep the legacy schema, desktop requests must decode as
 * the closed v2 union, and contract refusals become typed v2 results instead
 * of reaching any runtime.
 */
import { ComputerUseAction, type ComputerUseResult, type ThreadId } from "@bigbud/contracts";
import type {
  ComputerUseDesktopV2Action,
  ComputerUseDesktopV2Result,
  ComputerUseV2ErrorCode,
} from "@bigbud/contracts/orchestration/computerUseDesktopV2.ts";
import {
  selectedComputerUseContractProfile,
  type ComputerUseContractProfile,
} from "@bigbud/shared/computer-use/selection";
import { classifyDesktopV2Request } from "@bigbud/shared/computer-use/v2.request";
import { Effect, Schema } from "effect";

export type ComputerUseV2ToolRequest =
  | { readonly kind: "desktop_v2"; readonly action: ComputerUseDesktopV2Action }
  | { readonly kind: "refused"; readonly action: string; readonly code: ComputerUseV2ErrorCode };

export type ComputerUseToolRequest =
  | { readonly kind: "legacy"; readonly action: ComputerUseAction }
  | ComputerUseV2ToolRequest;

export type ComputerUseToolResult = ComputerUseResult | ComputerUseDesktopV2Result;

const decodeLegacyAction = Schema.decodeUnknownSync(ComputerUseAction);

export function decodeComputerUseToolRequest(
  raw: unknown,
  profile: ComputerUseContractProfile = selectedComputerUseContractProfile,
): ComputerUseToolRequest {
  if (profile === "legacy") return { kind: "legacy", action: decodeLegacyAction(raw) };
  const classified = classifyDesktopV2Request(raw);
  switch (classified.kind) {
    case "browser":
      return { kind: "legacy", action: decodeLegacyAction(raw) };
    case "desktop_v2":
      return classified;
    case "refused": {
      const action =
        raw !== null &&
        typeof raw === "object" &&
        typeof (raw as { action?: unknown }).action === "string"
          ? (raw as { action: string }).action
          : "unknown";
      return {
        kind: "refused",
        action: action.trim().slice(0, 64) || "unknown",
        code: classified.code,
      };
    }
  }
}

const REFUSAL_SUMMARIES: Partial<Record<ComputerUseV2ErrorCode, string>> = {
  version_required: 'Desktop computer use requires schemaVersion 2 and surface "desktop".',
  selector_conflict: "Raw pid/windowId selectors are not accepted; use a targetRef.",
  invalid_arguments: "The desktop computer-use request does not match the v2 contract.",
  control_unavailable:
    "Supervised desktop computer use is not available in this build; nothing was executed.",
  checkin_required:
    "Computer use has been running for a while. Ask the user whether to continue before using computer_use again.",
  deadline_exceeded: "The desktop action exceeded its deadline; its effect is unknown.",
};

/** A v2 result for a request that never started. */
export function refusedComputerUseV2Result(input: {
  readonly operationId: string;
  readonly action: string;
  readonly code: ComputerUseV2ErrorCode;
}): ComputerUseDesktopV2Result {
  return {
    schemaVersion: 2,
    surface: "desktop",
    operationId: input.operationId,
    action: input.action,
    executionStatus: "failed",
    completion: "not_started",
    refused: true,
    errorCode: input.code,
    summary: REFUSAL_SUMMARIES[input.code] ?? `Desktop computer use refused: ${input.code}.`,
  };
}

export type ComputerUseV2Dispatch = (input: {
  readonly threadId: ThreadId;
  readonly request: ComputerUseV2ToolRequest;
}) => Effect.Effect<ComputerUseDesktopV2Result, Error>;

export interface ComputerUseToolDispatcher {
  readonly computerUse: (input: {
    readonly threadId: ThreadId;
    readonly action: ComputerUseAction;
  }) => Effect.Effect<ComputerUseResult, Error>;
  readonly computerUseV2?: ComputerUseV2Dispatch;
}

export function computerUseV2RequestActionName(request: ComputerUseV2ToolRequest): string {
  return request.kind === "refused" ? request.action : request.action.action;
}

/**
 * The single fail-closed answer for a v2 request with no v2 route wired:
 * never falls back to the legacy runtime.
 */
export function unroutedComputerUseV2Result(
  request: ComputerUseV2ToolRequest,
): ComputerUseDesktopV2Result {
  return refusedComputerUseV2Result({
    operationId: crypto.randomUUID(),
    action: computerUseV2RequestActionName(request),
    code: request.kind === "refused" ? request.code : "control_unavailable",
  });
}

/** Legacy requests take the unchanged legacy dispatcher path. */
export function dispatchComputerUseToolRequest(
  dispatcher: ComputerUseToolDispatcher,
  threadId: ThreadId,
  request: ComputerUseToolRequest,
): Effect.Effect<ComputerUseToolResult, Error> {
  if (request.kind === "legacy") {
    return dispatcher.computerUse({ threadId, action: request.action });
  }
  if (dispatcher.computerUseV2) return dispatcher.computerUseV2({ threadId, request });
  return Effect.succeed(unroutedComputerUseV2Result(request));
}
