/**
 * Turn and interaction operations for CodexAppServerManager — send turns,
 * interrupt, read, rollback, and respond to requests/user-input.
 */
import {
  TurnId,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
} from "@bigbud/contracts";

import { resolveCodexModelForAccount } from "../provider/codexAccount";
import { buildCodexCollaborationMode, normalizeCodexModelSlug } from "./codexModeInstructions";
import { resolveCodexModelSelection } from "./codexAppServerManager.modelSelection";
import { readObject, readString } from "./codexAppServerManager.protocol";
import { readCodexThreadHistory } from "./codexAppServerManager.history.ts";
import { CodexRpcError } from "./codexAppServerManager.errors.ts";
import { hasQualifiedCodexModernProtocol } from "./codexAppServerManager.capabilities.ts";
import { compactBlocksWork } from "./codexAppServerManager.controls.state.ts";
import {
  type CodexAppServerSendTurnInput,
  type CodexAppServerSteerTurnInput,
  type CodexSessionContext,
  type CodexThreadSnapshot,
  type CodexWriteOptions,
} from "./codexAppServerManager.types";
import {
  mapCodexRuntimeMode,
  mapCodexTurnSandboxPolicy,
  readResumeThreadId,
} from "./codexAppServerManager.utils";

export interface TurnOps {
  readonly sendRequest: <T>(
    ctx: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs?: number,
    shouldDispatch?: () => boolean,
  ) => Promise<T>;
  readonly writeMessage: (
    ctx: CodexSessionContext,
    message: unknown,
    options?: CodexWriteOptions,
  ) => void | Promise<void>;
  readonly updateSession: (ctx: CodexSessionContext, updates: Partial<ProviderSession>) => void;
  readonly emitEvent: (event: ProviderEvent) => void;
}

export async function sendTurn(
  input: CodexAppServerSendTurnInput,
  context: CodexSessionContext,
  ops: TurnOps,
): Promise<ProviderTurnStartResult> {
  if (compactBlocksWork(context))
    throw new CodexRpcError(
      "turn/start",
      context.session.sessionEpoch,
      "not-dispatched",
      "Manual compaction is pending or uncertain; no turn was sent.",
    );
  context.historyGeneration = (context.historyGeneration ?? 0) + 1;
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
    if (attachment.type === "file") {
      throw new CodexRpcError(
        "turn/start",
        context.session.sessionEpoch,
        "not-dispatched",
        "Codex does not support native generic file input. Supply extracted text or a readable provider path.",
      );
    }
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
        reasoning_effort?: string;
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
    normalizeCodexModelSlug(
      input.model ?? context.session.model ?? context.effectiveModelSelection?.model,
    ),
    context.account,
  );
  const modelSelection = resolveCodexModelSelection({
    catalog: context.activeModelCatalog,
    current: context.effectiveModelSelection,
    model: normalizedModel,
    effort: input.effort,
    modelExplicitlyRequested: input.model !== undefined,
  });
  if (modelSelection.model) {
    turnStartParams.model = modelSelection.model;
  }
  if (input.serviceTier !== undefined) {
    if (input.serviceTier === null && !hasQualifiedCodexModernProtocol(context.runtimeVersion)) {
      throw new CodexRpcError(
        "turn/start",
        context.session.sessionEpoch,
        "not-dispatched",
        "Resetting the Codex service tier is unavailable for this unqualified runtime version.",
      );
    }
    turnStartParams.serviceTier = input.serviceTier;
  }
  if (modelSelection.effort !== undefined) {
    turnStartParams.effort = modelSelection.effort;
  }
  const collaborationMode = buildCodexCollaborationMode({
    ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    ...(modelSelection.model !== undefined ? { model: modelSelection.model } : {}),
    ...(modelSelection.effort !== undefined ? { effort: modelSelection.effort } : {}),
  });
  if (collaborationMode) {
    if (!turnStartParams.model) {
      turnStartParams.model = collaborationMode.settings.model;
    }
    turnStartParams.collaborationMode = collaborationMode;
  }

  const response = await ops.sendRequest(context, "turn/start", turnStartParams);

  const turn = readObject(readObject(response), "turn");
  const turnIdRaw = readString(turn, "id");
  if (!turnIdRaw) {
    throw new CodexRpcError(
      "turn/start",
      context.session.sessionEpoch,
      "possibly-applied",
      "turn/start response did not include a turn id.",
    );
  }
  const turnId = TurnId.makeUnsafe(turnIdRaw);
  context.ownedTurnId = turnId;

  context.effectiveModelSelection = modelSelection;
  ops.updateSession(context, {
    ...(context.completedTurnId === turnId
      ? {}
      : { status: "running" as const, activeTurnId: turnId }),
    model: modelSelection.model,
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

export async function steerTurn(
  input: CodexAppServerSteerTurnInput,
  context: CodexSessionContext,
  ops: TurnOps,
): Promise<void> {
  if (context.session.activeTurnId !== input.expectedTurnId) {
    throw new Error("The requested Codex turn is no longer active.");
  }
  const providerThreadId = readResumeThreadId({
    threadId: context.session.threadId,
    runtimeMode: context.session.runtimeMode,
    resumeCursor: context.session.resumeCursor,
  });
  if (!providerThreadId) throw new Error("Session is missing provider resume thread id.");

  const response = await ops.sendRequest<unknown>(context, "turn/steer", {
    threadId: providerThreadId,
    clientUserMessageId: input.clientUserMessageId,
    input: [{ type: "text", text: input.input, text_elements: [] }],
    expectedTurnId: input.expectedTurnId,
  });
  const acknowledgedTurnId = readString(readObject(response), "turnId");
  if (acknowledgedTurnId !== input.expectedTurnId) {
    throw new CodexRpcError(
      "turn/steer",
      context.session.sessionEpoch,
      "possibly-applied",
      "turn/steer acknowledgement did not match the expected turn.",
    );
  }
}

export async function readThread(
  context: CodexSessionContext,
  ops: TurnOps,
): Promise<CodexThreadSnapshot> {
  return readCodexThreadHistory(context, ops);
}

export async function rollbackThread(
  context: CodexSessionContext,
  numTurns: number,
  _ops: TurnOps,
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

  throw new CodexRpcError(
    "thread/rollback",
    context.session.sessionEpoch,
    "not-dispatched",
    "Codex count-based rewind is disabled: exact native boundaries and durable coordinated recovery are required. No native history or files were changed.",
  );
}
