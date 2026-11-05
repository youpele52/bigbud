import { EventEmitter } from "node:events";

import {
  ApprovalRequestId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
} from "@bigbud/contracts";
import { Effect, ServiceMap } from "effect";

import {
  attachProcessListeners,
  handleResponse,
  handleServerNotification,
  handleServerRequest,
  handleStdoutLine,
} from "./codexAppServerManager.handlers";
import {
  type CodexAppServerManagerEvents,
  type CodexAppServerSendTurnInput,
  type CodexAppServerStartSessionInput,
  type CodexAppServerSteerTurnInput,
  type CodexSessionContext,
  type CodexThreadSnapshot,
  type CodexWriteOptions,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./codexAppServerManager.types";
import {
  killChildTree,
  normalizeProviderThreadId,
  readResumeThreadId,
} from "./codexAppServerManager.utils";
import { type StartSessionOps, startSession } from "./codexAppServerManager.startSession";
import { CodexPendingStarts } from "./codexAppServerManager.pendingStarts";
import {
  type TurnOps,
  interruptTurn,
  readThread,
  rollbackThread,
  sendTurn,
  steerTurn,
} from "./codexAppServerManager.turn";
import { respondToRequest, respondToUserInput } from "./codexAppServerManager.interactions.ts";
import { interruptChildTurns } from "./codexAppServerManager.turn.children";
import { CodexSessionUnavailableError } from "./codexAppServerManager.errors.ts";
import {
  prepareCodexRewind,
  revertCodexThread,
  verifyCodexRewind,
} from "./codexAppServerManager.rewind.ts";
import type {
  ProviderExactRewindInput,
  ProviderPreparedRewind,
} from "../provider/Services/ProviderRewind.ts";
import { confirmCodexInspectedTurn, inspectCodexTurn } from "./codexAppServerManager.inspection.ts";
import {
  closeCodexTransport,
  sendCodexRequest,
  writeCodexMessage,
} from "./codexAppServerManager.transport.ts";
import { codexProviderControls } from "./codexAppServerManager.controls.ts";
import { codexSessionEvent } from "./codexAppServerManager.events.ts";
import { confirmCodexCompaction } from "./codexAppServerManager.controls.state.ts";
import type { CodexCompactionConfirmation } from "../provider/Services/ProviderCompaction.ts";

export { buildCodexInitializeParams } from "../provider/codexAppServer";
export { readCodexAccountSnapshot, resolveCodexModelForAccount } from "../provider/codexAccount";
export { hasReadyMcpServers, waitForMcpServersReady } from "./codexAppServerManager.startSession";
export {
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  normalizeCodexModelSlug,
} from "./codexModeInstructions";
export { classifyCodexStderrLine, isRecoverableThreadResumeError } from "./codexStderrClassifier";
export {
  CODEX_MCP_STARTUP_STATUS_UPDATED,
  CODEX_REQUIRED_MCP_READINESS_TIMEOUT_MS,
  createCodexMcpReadinessTracker,
} from "./codexAppServerManager.mcpReadiness.ts";

export type {
  CodexAppServerSendTurnInput,
  CodexAppServerStartSessionInput,
  CodexAppServerSteerTurnInput,
  CodexAppServerManagerEvents,
  CodexThreadSnapshot,
} from "./codexAppServerManager.types";
export type { CodexThreadTurnSnapshot } from "./codexAppServerManager.types";

export class CodexAppServerManager extends EventEmitter<CodexAppServerManagerEvents> {
  private readonly sessions = new Map<ThreadId, CodexSessionContext>();
  private readonly pendingStarts = new CodexPendingStarts();

  private runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  constructor(services?: ServiceMap.ServiceMap<never>) {
    super();
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
  }

  async startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    const ops: StartSessionOps = {
      runPromise: this.runPromise,
      sessions: this.sessions,
      pendingStarts: this.pendingStarts,
      sendRequest: (ctx, method, params, timeoutMs) =>
        this.sendRequest(ctx, method, params, timeoutMs),
      writeMessage: (ctx, msg) => this.writeMessage(ctx, msg),
      attachProcessListeners: (ctx) => this.attachProcessListeners(ctx),
      updateSession: (ctx, updates) => this.updateSession(ctx, updates),
      emitEvent: (event) => this.emitEvent(event),
      emitLifecycleEvent: (ctx, method, message) => this.emitLifecycleEvent(ctx, method, message),
      emitErrorEvent: (ctx, method, message) => this.emitErrorEvent(ctx, method, message),
      stopSession: (threadId) => this.stopSession(threadId),
    };
    return startSession(input, ops);
  }

  async sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    return sendTurn(input, context, this.turnOps());
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const context = this.requireSession(threadId);
    return interruptTurn(context, turnId, this.turnOps());
  }

  /** Thread Stop: interrupt the running turn of each listed child agent thread. */
  async interruptChildTurns(threadId: ThreadId, childThreadIds: ReadonlyArray<string>) {
    return interruptChildTurns(this.requireSession(threadId), childThreadIds, this.turnOps());
  }

  async steerTurn(input: CodexAppServerSteerTurnInput): Promise<void> {
    const context = this.requireSession(input.threadId);
    return steerTurn(input, context, this.turnOps());
  }

  async readThread(threadId: ThreadId): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    return readThread(context, this.turnOps());
  }

  async rollbackThread(threadId: ThreadId, numTurns: number): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    return rollbackThread(context, numTurns, this.turnOps());
  }

  async prepareRewind(input: ProviderExactRewindInput) {
    return prepareCodexRewind(this.requireSession(input.threadId), input, this.turnOps());
  }

  async providerControls(
    input: import("@bigbud/contracts/server/providerControls").ProviderControlsInput,
  ) {
    const context = this.requireSession(input.threadId);
    return codexProviderControls(
      context,
      input,
      this.turnOps(),
      () => this.sessions.get(input.threadId) === context,
    );
  }

  confirmCompaction(input: CodexCompactionConfirmation, persisted: boolean) {
    return confirmCodexCompaction(this.sessions.get(input.threadId), input, persisted);
  }

  async inspectActiveTurn(threadId: ThreadId, turnId: TurnId) {
    const context = this.sessions.get(threadId);
    if (!context) return { status: "unavailable" as const, observedAt: new Date().toISOString() };
    const result = await inspectCodexTurn(context, turnId, this.turnOps());
    return this.sessions.get(threadId) === context
      ? result
      : { status: "unavailable" as const, observedAt: new Date().toISOString() };
  }

  confirmInspectedTurn(
    threadId: ThreadId,
    turnId: TurnId,
    epoch: number,
    status: "completed" | "failed",
    publication?: import("@bigbud/contracts").ProviderRuntimeEvent,
  ) {
    const context = this.sessions.get(threadId);
    return confirmCodexInspectedTurn(
      context,
      turnId,
      epoch,
      status,
      this.turnOps(),
      publication,
      () => this.sessions.get(threadId) === context,
    );
  }

  async revertThread(input: ProviderPreparedRewind) {
    return revertCodexThread(this.requireSession(input.threadId), input, this.turnOps());
  }

  async verifyRewind(input: ProviderPreparedRewind) {
    return verifyCodexRewind(this.requireSession(input.threadId), input, this.turnOps());
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    await respondToRequest(context, requestId, decision, this.turnOps());
  }

  async respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    await respondToUserInput(context, requestId, answers, this.turnOps());
  }

  stopSession(threadId: ThreadId): void {
    this.pendingStarts.cancel(threadId);
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    context.stopping = true;
    context.mcpReadiness?.cancel(
      new Error("Codex session stopped while waiting for MCP readiness."),
    );

    closeCodexTransport(context, new Error("Session stopped before request completed."));
    context.pendingApprovals.clear();
    context.pendingUserInputs.clear();

    context.output.close();

    if (!context.child.killed) {
      killChildTree(context.child);
    }

    void context.cleanupRemoteWorkspaceBridge?.().catch(() => undefined);

    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });
    this.emitLifecycleEvent(context, "session/closed", "Session stopped");
    this.sessions.delete(threadId);
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values(), ({ session }) => ({
      ...session,
    }));
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  stopAll(): void {
    this.pendingStarts.cancelAll();
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
  }

  private turnOps(): TurnOps {
    return {
      sendRequest: (ctx, method, params, timeoutMs, shouldDispatch) =>
        shouldDispatch === undefined
          ? this.sendRequest(ctx, method, params, timeoutMs)
          : this.sendRequest(ctx, method, params, timeoutMs, shouldDispatch),
      writeMessage: (ctx, msg, options) => this.writeMessage(ctx, msg, options),
      updateSession: (ctx, updates) => this.updateSession(ctx, updates),
      emitEvent: (event) => this.emitEvent(event),
    };
  }

  private requireSession(threadId: ThreadId): CodexSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new CodexSessionUnavailableError("missing");
    }

    if (context.session.status === "closed") {
      throw new CodexSessionUnavailableError("closed", context.session.sessionEpoch);
    }

    return context;
  }

  private attachProcessListeners(context: CodexSessionContext): void {
    attachProcessListeners(context, {
      onStdoutLine: (ctx, line) => this.handleStdoutLine(ctx, line),
      emitNotificationEvent: (ctx, method, message) =>
        this.emitNotificationEvent(ctx, method, message),
      updateSession: (ctx, updates) => this.updateSession(ctx, updates),
      emitErrorEvent: (ctx, method, message) => this.emitErrorEvent(ctx, method, message),
      emitLifecycleEvent: (ctx, method, message) => this.emitLifecycleEvent(ctx, method, message),
      sessions: this.sessions,
    });
  }

  private handleStdoutLine(context: CodexSessionContext, line: string): void {
    if (context.stopping || this.sessions.get(context.session.threadId) !== context) return;
    handleStdoutLine(context, line, {
      handleServerRequest: (ctx, req) => this.handleServerRequest(ctx, req),
      handleServerNotification: (ctx, notif) => this.handleServerNotification(ctx, notif),
      handleResponse: (ctx, resp) => this.handleResponse(ctx, resp),
      emitErrorEvent: (ctx, method, message) => this.emitErrorEvent(ctx, method, message),
    });
  }

  private handleServerNotification(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
  ): void {
    handleServerNotification(context, notification, {
      emitEvent: (event) => this.emitEvent(event),
      updateSession: (ctx, updates) => this.updateSession(ctx, updates),
    });
  }

  private handleServerRequest(context: CodexSessionContext, request: JsonRpcRequest): void {
    handleServerRequest(context, request, {
      emitEvent: (event) => this.emitEvent(event),
      writeMessage: (ctx, message) => this.writeMessage(ctx, message),
      isCurrent: () => this.sessions.get(context.session.threadId) === context,
    });
  }

  private handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
    handleResponse(context, response);
  }

  private async sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs = 20_000,
    shouldDispatch?: () => boolean,
  ): Promise<TResponse> {
    return sendCodexRequest<TResponse>(context, method, params, timeoutMs, shouldDispatch);
  }

  private writeMessage(
    context: CodexSessionContext,
    message: unknown,
    options?: CodexWriteOptions,
  ): Promise<void> {
    return writeCodexMessage(context, message, options);
  }

  private emitLifecycleEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent(codexSessionEvent(context, "session", method, message));
  }

  private emitErrorEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent(codexSessionEvent(context, "error", method, message));
  }

  private emitNotificationEvent(
    context: CodexSessionContext,
    method: string,
    message: string,
  ): void {
    this.emitEvent(codexSessionEvent(context, "notification", method, message));
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }

  private updateSession(context: CodexSessionContext, updates: Partial<ProviderSession>): void {
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }
}

// Re-export standalone utilities that external consumers may have imported
export { normalizeProviderThreadId, readResumeThreadId } from "./codexAppServerManager.utils";
