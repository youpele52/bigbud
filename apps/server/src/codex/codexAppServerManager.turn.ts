/**
 * Turn and interaction operations for CodexAppServerManager — send turns,
 * interrupt, read, rollback, and respond to requests/user-input.
 */
import { randomUUID } from "node:crypto";

import {
  ApprovalRequestId,
  EventId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
} from "@bigbud/contracts";

import { resolveCodexModelForAccount } from "../provider/codexAccount";
import { buildCodexCollaborationMode, normalizeCodexModelSlug } from "./codexModeInstructions";
import { parseThreadSnapshot } from "./codexAppServerManager.protocol";
import {
  type CodexAppServerSendTurnInput,
  type CodexSessionContext,
  type CodexThreadSnapshot,
} from "./codexAppServerManager.types";
import {
  mapCodexRuntimeMode,
  mapCodexTurnSandboxPolicy,
  readResumeThreadId,
  toCodexUserInputAnswers,
} from "./codexAppServerManager.utils";

export interface TurnOps {
  readonly sendRequest: <T>(
    ctx: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs?: number,
  ) => Promise<T>;
  readonly writeMessage: (ctx: CodexSessionContext, message: unknown) => void;
  readonly updateSession: (ctx: CodexSessionContext, updates: Partial<ProviderSession>) => void;
  readonly emitEvent: (event: ProviderEvent) => void;
}

export async function sendTurn(
  input: CodexAppServerSendTurnInput,
  context: CodexSessionContext,
  ops: TurnOps,
): Promise<ProviderTurnStartResult> {
  context.collabReceiverTurns.clear();

  const turnInput: Array<
    { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
  > = [];
  if (input.input) {
    turnInput.push({
      type: "text",
      text: input.input,
      text_elements: [],
    });
  }
  for (const attachment of input.attachments ?? []) {
    if (attachment.type === "image") {
      turnInput.push({
        type: "image",
        url: attachment.url,
      });
    }
  }
  if (turnInput.length === 0) {
    throw new Error("Turn input must include text or attachments.");
  }

  const providerThreadId = readResumeThreadId({
    threadId: context.session.threadId,
    runtimeMode: context.session.runtimeMode,
    resumeCursor: context.session.resumeCursor,
  });
  if (!providerThreadId) {
    throw new Error("Session is missing provider resume thread id.");
  }
  const turnStartParams: {
    threadId: string;
    input: Array<
      { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
    >;
    model?: string;
    serviceTier?: string | null;
    effort?: string;
    collaborationMode?: {
      mode: "default" | "plan";
      settings: {
        model: string;
        reasoning_effort: string;
        developer_instructions: string;
      };
    };
    approvalPolicy?: "untrusted" | "on-request" | "never";
    sandboxPolicy?:
      | { readonly type: "readOnly" }
      | { readonly type: "workspaceWrite" }
      | { readonly type: "dangerFullAccess" };
  } = {
    threadId: providerThreadId,
    input: turnInput,
  };
  const runtimeConfig = mapCodexRuntimeMode(context.session.runtimeMode);
  turnStartParams.approvalPolicy = runtimeConfig.approvalPolicy;
  turnStartParams.sandboxPolicy = mapCodexTurnSandboxPolicy(context.session.runtimeMode);
  const normalizedModel = resolveCodexModelForAccount(
    normalizeCodexModelSlug(input.model ?? context.session.model),
    context.account,
  );
  if (normalizedModel) {
    turnStartParams.model = normalizedModel;
  }
  if (input.serviceTier !== undefined) {
    turnStartParams.serviceTier = input.serviceTier;
  }
  if (input.effort) {
    turnStartParams.effort = input.effort;
  }
  const collaborationMode = buildCodexCollaborationMode({
    ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
  });
  if (collaborationMode) {
    if (!turnStartParams.model) {
      turnStartParams.model = collaborationMode.settings.model;
    }
    turnStartParams.collaborationMode = collaborationMode;
  }

  const response = await ops.sendRequest(context, "turn/start", turnStartParams);

  const turn = readObj(readObj(response), "turn");
  const turnIdRaw = readStr(turn, "id");
  if (!turnIdRaw) {
    throw new Error("turn/start response did not include a turn id.");
  }
  const turnId = TurnId.makeUnsafe(turnIdRaw);

  ops.updateSession(context, {
    status: "running",
    activeTurnId: turnId,
    ...(context.session.resumeCursor !== undefined
      ? { resumeCursor: context.session.resumeCursor }
      : {}),
  });

  return {
    threadId: context.session.threadId,
    turnId,
    ...(context.session.resumeCursor !== undefined
      ? { resumeCursor: context.session.resumeCursor }
      : {}),
  };
}

export async function interruptTurn(
  context: CodexSessionContext,
  turnId: TurnId | undefined,
  ops: TurnOps,
): Promise<void> {
  const effectiveTurnId = turnId ?? context.session.activeTurnId;

  const providerThreadId = readResumeThreadId({
    threadId: context.session.threadId,
    runtimeMode: context.session.runtimeMode,
    resumeCursor: context.session.resumeCursor,
  });
  if (!effectiveTurnId || !providerThreadId) {
    return;
  }

  await ops.sendRequest(context, "turn/interrupt", {
    threadId: providerThreadId,
    turnId: effectiveTurnId,
  });
}

export async function readThread(
  context: CodexSessionContext,
  ops: TurnOps,
): Promise<CodexThreadSnapshot> {
  const providerThreadId = readResumeThreadId({
    threadId: context.session.threadId,
    runtimeMode: context.session.runtimeMode,
    resumeCursor: context.session.resumeCursor,
  });
  if (!providerThreadId) {
    throw new Error("Session is missing a provider resume thread id.");
  }

  const response = await ops.sendRequest(context, "thread/read", {
    threadId: providerThreadId,
    includeTurns: true,
  });
  return parseThreadSnapshot("thread/read", response);
}

export async function rollbackThread(
  context: CodexSessionContext,
  numTurns: number,
  ops: TurnOps,
): Promise<CodexThreadSnapshot> {
  const providerThreadId = readResumeThreadId({
    threadId: context.session.threadId,
    runtimeMode: context.session.runtimeMode,
    resumeCursor: context.session.resumeCursor,
  });
  if (!providerThreadId) {
    throw new Error("Session is missing a provider resume thread id.");
  }
  if (!Number.isInteger(numTurns) || numTurns < 1) {
    throw new Error("numTurns must be an integer >= 1.");
  }

  const response = await ops.sendRequest(context, "thread/rollback", {
    threadId: providerThreadId,
    numTurns,
  });
  ops.updateSession(context, {
    status: "ready",
    activeTurnId: undefined,
  });
  return parseThreadSnapshot("thread/rollback", response);
}

export function respondToRequest(
  context: CodexSessionContext,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  ops: TurnOps,
): void {
  const pendingRequest = context.pendingApprovals.get(requestId);
  if (!pendingRequest) {
    throw new Error(`Unknown pending approval request: ${requestId}`);
  }

  context.pendingApprovals.delete(requestId);
  ops.writeMessage(context, {
    id: pendingRequest.jsonRpcId,
    result: {
      decision,
    },
  });

  ops.emitEvent({
    id: EventId.makeUnsafe(randomUUID()),
    kind: "notification",
    provider: "codex",
    threadId: context.session.threadId,
    createdAt: new Date().toISOString(),
    method: "item/requestApproval/decision",
    turnId: pendingRequest.turnId,
    itemId: pendingRequest.itemId,
    requestId: pendingRequest.requestId,
    requestKind: pendingRequest.requestKind,
    payload: {
      requestId: pendingRequest.requestId,
      requestKind: pendingRequest.requestKind,
      decision,
    },
  });
}

export function respondToUserInput(
  context: CodexSessionContext,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  ops: TurnOps,
): void {
  const pendingRequest = context.pendingUserInputs.get(requestId);
  if (!pendingRequest) {
    throw new Error(`Unknown pending user input request: ${requestId}`);
  }

  context.pendingUserInputs.delete(requestId);
  const codexAnswers = toCodexUserInputAnswers(answers);
  ops.writeMessage(context, {
    id: pendingRequest.jsonRpcId,
    result: {
      answers: codexAnswers,
    },
  });

  ops.emitEvent({
    id: EventId.makeUnsafe(randomUUID()),
    kind: "notification",
    provider: "codex",
    threadId: context.session.threadId,
    createdAt: new Date().toISOString(),
    method: "item/tool/requestUserInput/answered",
    turnId: pendingRequest.turnId,
    itemId: pendingRequest.itemId,
    requestId: pendingRequest.requestId,
    payload: {
      requestId: pendingRequest.requestId,
      answers: codexAnswers,
    },
  });
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function readObj(value: unknown, key?: string): Record<string, unknown> | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;

  if (!target || typeof target !== "object") {
    return undefined;
  }

  return target as Record<string, unknown>;
}

function readStr(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}
