import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  ApprovalRequestId,
  EventId,
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
  type CodexSessionContext,
  type CodexThreadSnapshot,
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
import {
  type TurnOps,
  interruptTurn,
  readThread,
  respondToRequest,
  respondToUserInput,
  rollbackThread,
  sendTurn,
} from "./codexAppServerManager.turn";

export { buildCodexInitializeParams } from "../provider/codexAppServer";
export { readCodexAccountSnapshot, resolveCodexModelForAccount } from "../provider/codexAccount";
export {
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  normalizeCodexModelSlug,
} from "./codexModeInstructions";
export { classifyCodexStderrLine, isRecoverableThreadResumeError } from "./codexStderrClassifier";

export type {
  CodexAppServerSendTurnInput,
  CodexAppServerStartSessionInput,
  CodexAppServerManagerEvents,
  CodexThreadSnapshot,
} from "./codexAppServerManager.types";
export type { CodexThreadTurnSnapshot } from "./codexAppServerManager.types";

export class CodexAppServerManager extends EventEmitter<CodexAppServerManagerEvents> {
  private readonly sessions = new Map<ThreadId, CodexSessionContext>();

  private runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  constructor(services?: ServiceMap.ServiceMap<never>) {
    super();
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
  }

  async startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    const ops: StartSessionOps = {
      runPromise: this.runPromise,
      sessions: this.sessions,
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

  async readThread(threadId: ThreadId): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    return readThread(context, this.turnOps());
  }

  async rollbackThread(threadId: ThreadId, numTurns: number): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    return rollbackThread(context, numTurns, this.turnOps());
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    respondToRequest(context, requestId, decision, this.turnOps());
  }

  async respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    respondToUserInput(context, requestId, answers, this.turnOps());
  }

  stopSession(threadId: ThreadId): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    context.stopping = true;

    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Session stopped before request completed."));
    }
    context.pending.clear();
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
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
  }

  private turnOps(): TurnOps {
    return {
      sendRequest: (ctx, method, params, timeoutMs) =>
        this.sendRequest(ctx, method, params, timeoutMs),
      writeMessage: (ctx, msg) => this.writeMessage(ctx, msg),
      updateSession: (ctx, updates) => this.updateSession(ctx, updates),
      emitEvent: (event) => this.emitEvent(event),
    };
  }

  private requireSession(threadId: ThreadId): CodexSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown session for thread: ${threadId}`);
    }

    if (context.session.status === "closed") {
      throw new Error(`Session is closed for thread: ${threadId}`);
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
  ): Promise<TResponse> {
    const id = context.nextRequestId;
    context.nextRequestId += 1;

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        context.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      context.pending.set(String(id), {
        method,
        timeout,
        resolve,
        reject,
      });
      this.writeMessage(context, {
        method,
        id,
        params,
      });
    });

    return result as TResponse;
  }

  private writeMessage(context: CodexSessionContext, message: unknown): void {
    const encoded = JSON.stringify(message);
    if (!context.child.stdin.writable) {
      throw new Error("Cannot write to codex app-server stdin.");
    }

    context.child.stdin.write(`${encoded}\n`);
  }

  private emitLifecycleEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "session",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitErrorEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "error",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitNotificationEvent(
    context: CodexSessionContext,
    method: string,
    message: string,
  ): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
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
