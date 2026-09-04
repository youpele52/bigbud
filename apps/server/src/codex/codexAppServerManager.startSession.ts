/**
 * Session startup logic for CodexAppServerManager — extracted to keep the
 * manager class focused on session lifecycle bookkeeping.
 */
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import { EventId, ThreadId, type ProviderEvent, type ProviderSession } from "@bigbud/contracts";
import { Effect } from "effect";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import { readCodexAccountSnapshot, resolveCodexModelForAccount } from "../provider/codexAccount";
import { buildCodexInitializeParams } from "../provider/codexAppServer";
import {
  includeConfiguredCodexModels,
  parseCodexModelsResult,
} from "../provider/codexAppServer.models";
import {
  isCodexModelSelectionError,
  resolveCodexModelSelection,
} from "./codexAppServerManager.modelSelection";
import { normalizeCodexModelSlug } from "./codexModeInstructions";
import { isRecoverableThreadResumeError } from "./codexStderrClassifier";
import { startCodexAppServerProcess } from "./codexAppServerManager.process";
import { hasReadyMcpServers, sleep } from "./codexAppServerManager.mcp";
import { readObject, readString } from "./codexAppServerManager.protocol";
import {
  type CodexAppServerStartSessionInput,
  type CodexSessionContext,
} from "./codexAppServerManager.types";
import { mapCodexRuntimeMode, readResumeThreadId } from "./codexAppServerManager.utils";
export { hasReadyMcpServers } from "./codexAppServerManager.mcp";

export interface StartSessionOps {
  readonly runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  readonly sessions: Map<ThreadId, CodexSessionContext>;
  readonly sendRequest: <T>(
    ctx: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs?: number,
  ) => Promise<T>;
  readonly writeMessage: (ctx: CodexSessionContext, message: unknown) => void;
  readonly attachProcessListeners: (ctx: CodexSessionContext) => void;
  readonly updateSession: (ctx: CodexSessionContext, updates: Partial<ProviderSession>) => void;
  readonly emitEvent: (event: ProviderEvent) => void;
  readonly emitLifecycleEvent: (ctx: CodexSessionContext, method: string, message: string) => void;
  readonly emitErrorEvent: (ctx: CodexSessionContext, method: string, message: string) => void;
  readonly stopSession: (threadId: ThreadId) => void;
}

const MCP_SERVER_STATUS_RETRY_DELAY_MS = 150;
const MCP_SERVER_STATUS_TIMEOUT_MS = 4_000;
const MODEL_CATALOG_TIMEOUT_MS = 5_000;

export async function waitForMcpServersReady(
  context: CodexSessionContext,
  ops: Pick<StartSessionOps, "emitLifecycleEvent" | "sendRequest">,
  expectedServerNames: ReadonlyArray<string>,
): Promise<void> {
  if (expectedServerNames.length === 0) {
    return;
  }

  const deadline = Date.now() + MCP_SERVER_STATUS_TIMEOUT_MS;
  do {
    let status: unknown;
    try {
      status = await ops.sendRequest(
        context,
        "mcpServerStatus/list",
        {
          detail: "toolsAndAuthOnly",
          cursor: null,
          limit: 100,
        },
        1_000,
      );
    } catch (error) {
      ops.emitLifecycleEvent(
        context,
        "session/mcpStatusUnavailable",
        error instanceof Error ? error.message : "Codex MCP server status probe failed.",
      );
      return;
    }
    if (hasReadyMcpServers(status, expectedServerNames)) {
      return;
    }
    await sleep(MCP_SERVER_STATUS_RETRY_DELAY_MS);
  } while (Date.now() < deadline);

  ops.emitLifecycleEvent(
    context,
    "session/mcpStatusPending",
    `Codex MCP servers were not ready before thread start: ${expectedServerNames.join(", ")}.`,
  );
}

export async function startSession(
  input: CodexAppServerStartSessionInput,
  ops: StartSessionOps,
): Promise<ProviderSession> {
  const threadId = input.threadId;
  const now = new Date().toISOString();
  let context: CodexSessionContext | undefined;

  try {
    const resolvedCwd =
      input.cwd ??
      (isLocalExecutionTarget(input.workspaceExecutionTargetId ?? input.executionTargetId)
        ? process.cwd()
        : (() => {
            throw new Error("Remote Codex sessions require a remote workspace path.");
          })());

    const session: ProviderSession = {
      provider: "codex",
      status: "connecting",
      runtimeMode: input.runtimeMode,
      ...(input.providerRuntimeExecutionTargetId
        ? { providerRuntimeExecutionTargetId: input.providerRuntimeExecutionTargetId }
        : {}),
      ...(input.workspaceExecutionTargetId
        ? { workspaceExecutionTargetId: input.workspaceExecutionTargetId }
        : {}),
      ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
      model: normalizeCodexModelSlug(input.model),
      cwd: resolvedCwd,
      threadId,
      ...(input.sessionEpoch !== undefined ? { sessionEpoch: input.sessionEpoch } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const child = startCodexAppServerProcess(input, resolvedCwd);
    const output = readline.createInterface({ input: child.stdout });

    context = {
      session,
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: false,
      },
      child,
      output,
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      activeModelCatalog: undefined,
      effectiveModelSelection: undefined,
      nextRequestId: 1,
      ...(input.dynamicToolCallHandler
        ? { dynamicToolCallHandler: input.dynamicToolCallHandler }
        : {}),
      ...(input.cleanupRemoteWorkspaceBridge
        ? { cleanupRemoteWorkspaceBridge: input.cleanupRemoteWorkspaceBridge }
        : {}),
      stopping: false,
    };

    ops.sessions.set(threadId, context);
    ops.attachProcessListeners(context);

    ops.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

    await ops.sendRequest(context, "initialize", buildCodexInitializeParams());
    ops.writeMessage(context, { method: "initialized" });
    await waitForMcpServersReady(context, ops, input.expectedMcpServerNames ?? []);
    try {
      const modelListResponse = await ops.sendRequest(
        context,
        "model/list",
        {},
        MODEL_CATALOG_TIMEOUT_MS,
      );
      const parsedModels = parseCodexModelsResult(modelListResponse);
      context.activeModelCatalog =
        parsedModels === undefined
          ? undefined
          : includeConfiguredCodexModels(parsedModels, input.customModels ?? []);
      console.log("codex model/list response", modelListResponse);
    } catch (error) {
      context.activeModelCatalog = undefined;
      console.log("codex model/list failed", error);
    }
    try {
      const accountReadResponse = await ops.sendRequest(context, "account/read", {});
      console.log("codex account/read response", accountReadResponse);
      context.account = readCodexAccountSnapshot(accountReadResponse);
      console.log("codex subscription status", {
        type: context.account.type,
        planType: context.account.planType,
        sparkEnabled: context.account.sparkEnabled,
      });
    } catch (error) {
      console.log("codex account/read failed", error);
    }

    const normalizedModel = resolveCodexModelForAccount(
      normalizeCodexModelSlug(input.model),
      context.account,
    );
    const modelSelection = resolveCodexModelSelection({
      catalog: context.activeModelCatalog,
      current: context.effectiveModelSelection,
      model: normalizedModel,
      effort: input.effort,
      modelExplicitlyRequested: input.model !== undefined,
    });
    const sessionOverrides = {
      model: modelSelection.model ?? null,
      ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
      ...(modelSelection.effort !== undefined
        ? { config: { model_reasoning_effort: modelSelection.effort } }
        : {}),
      cwd: input.cwd ?? null,
      ...(input.developerInstructions
        ? { developerInstructions: input.developerInstructions }
        : {}),
      ...mapCodexRuntimeMode(input.runtimeMode ?? "full-access"),
    };

    const threadStartParams = {
      ...sessionOverrides,
      experimentalRawEvents: false,
      ...(input.dynamicTools && input.dynamicTools.length > 0
        ? { dynamicTools: input.dynamicTools }
        : {}),
    };
    const resumeThreadId = readResumeThreadId(input);
    ops.emitLifecycleEvent(
      context,
      "session/threadOpenRequested",
      resumeThreadId
        ? `Attempting to resume thread ${resumeThreadId}.`
        : "Starting a new Codex thread.",
    );
    await Effect.logInfo("codex app-server opening thread", {
      threadId,
      requestedRuntimeMode: input.runtimeMode,
      requestedModel: normalizedModel ?? null,
      requestedCwd: resolvedCwd,
      resumeThreadId: resumeThreadId ?? null,
    }).pipe(ops.runPromise);

    let threadOpenMethod: "thread/start" | "thread/resume" = "thread/start";
    let threadOpenResponse: unknown;
    if (resumeThreadId) {
      try {
        threadOpenMethod = "thread/resume";
        threadOpenResponse = await ops.sendRequest(context, "thread/resume", {
          ...sessionOverrides,
          threadId: resumeThreadId,
        });
      } catch (error) {
        if (!isRecoverableThreadResumeError(error)) {
          ops.emitErrorEvent(
            context,
            "session/threadResumeFailed",
            error instanceof Error ? error.message : "Codex thread resume failed.",
          );
          await Effect.logWarning("codex app-server thread resume failed", {
            threadId,
            requestedRuntimeMode: input.runtimeMode,
            resumeThreadId,
            recoverable: false,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(ops.runPromise);
          throw error;
        }

        threadOpenMethod = "thread/start";
        ops.emitLifecycleEvent(
          context,
          "session/threadResumeFallback",
          `Could not resume thread ${resumeThreadId}; started a new thread instead.`,
        );
        await Effect.logWarning("codex app-server thread resume fell back to fresh start", {
          threadId,
          requestedRuntimeMode: input.runtimeMode,
          resumeThreadId,
          recoverable: true,
          cause: error instanceof Error ? error.message : String(error),
        }).pipe(ops.runPromise);
        threadOpenResponse = await ops.sendRequest(context, "thread/start", threadStartParams);
      }
    } else {
      threadOpenMethod = "thread/start";
      threadOpenResponse = await ops.sendRequest(context, "thread/start", threadStartParams);
    }

    const threadOpenRecord = readObject(threadOpenResponse);
    const threadIdRaw =
      readString(readObject(threadOpenRecord, "thread"), "id") ??
      readString(threadOpenRecord, "threadId");
    if (!threadIdRaw) {
      throw new Error(`${threadOpenMethod} response did not include a thread id.`);
    }
    const providerThreadId = threadIdRaw;

    context.effectiveModelSelection = modelSelection;
    ops.updateSession(context, {
      status: "ready",
      model: modelSelection.model,
      resumeCursor: { threadId: providerThreadId },
    });
    ops.emitLifecycleEvent(
      context,
      "session/threadOpenResolved",
      `Codex ${threadOpenMethod} resolved.`,
    );
    await Effect.logInfo("codex app-server thread open resolved", {
      threadId,
      threadOpenMethod,
      requestedResumeThreadId: resumeThreadId ?? null,
      resolvedThreadId: providerThreadId,
      requestedRuntimeMode: input.runtimeMode,
    }).pipe(ops.runPromise);
    ops.emitLifecycleEvent(context, "session/ready", `Connected to thread ${providerThreadId}`);
    return { ...context.session };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start Codex session.";
    if (context) {
      ops.updateSession(context, {
        status: "error",
        lastError: message,
      });
      ops.emitErrorEvent(context, "session/startFailed", message);
      ops.stopSession(threadId);
    } else {
      ops.emitEvent({
        id: EventId.makeUnsafe(randomUUID()),
        kind: "error",
        provider: "codex",
        threadId,
        createdAt: new Date().toISOString(),
        method: "session/startFailed",
        message,
      });
    }
    if (isCodexModelSelectionError(error)) {
      throw error;
    }
    throw new Error(message, { cause: error });
  }
}
