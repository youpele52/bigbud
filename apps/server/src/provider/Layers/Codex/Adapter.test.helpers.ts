import { vi } from "@effect/vitest";
import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { Effect, Layer, Option } from "effect";

import {
  CodexAppServerManager,
  type CodexAppServerStartSessionInput,
  type CodexAppServerSendTurnInput,
} from "../../../codex/codexAppServerManager.ts";
import { ProviderSessionDirectory } from "../../Services/ProviderSessionDirectory.ts";

export const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
export const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
export const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
export const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);

export class FakeCodexManager extends CodexAppServerManager {
  public startSessionImpl = vi.fn(
    async (input: CodexAppServerStartSessionInput): Promise<ProviderSession> => {
      const now = new Date().toISOString();
      return {
        provider: "codex",
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        ...(input.providerRuntimeExecutionTargetId
          ? { providerRuntimeExecutionTargetId: input.providerRuntimeExecutionTargetId }
          : {}),
        ...(input.workspaceExecutionTargetId
          ? { workspaceExecutionTargetId: input.workspaceExecutionTargetId }
          : {}),
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
        cwd: input.cwd,
        createdAt: now,
        updatedAt: now,
      };
    },
  );

  public sendTurnImpl = vi.fn(
    async (_input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> => ({
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
    }),
  );

  public interruptTurnImpl = vi.fn(
    async (_threadId: ThreadId, _turnId?: TurnId): Promise<void> => undefined,
  );

  public readThreadImpl = vi.fn(async (_threadId: ThreadId) => ({
    threadId: asThreadId("thread-1"),
    turns: [],
  }));

  public rollbackThreadImpl = vi.fn(async (_threadId: ThreadId, _numTurns: number) => ({
    threadId: asThreadId("thread-1"),
    turns: [],
  }));

  public respondToRequestImpl = vi.fn(
    async (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ): Promise<void> => undefined,
  );

  public respondToUserInputImpl = vi.fn(
    async (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ): Promise<void> => undefined,
  );

  public stopAllImpl = vi.fn(() => undefined);

  override startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    return this.startSessionImpl(input);
  }

  override sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    return this.sendTurnImpl(input);
  }

  override interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    return this.interruptTurnImpl(threadId, turnId);
  }

  override readThread(threadId: ThreadId) {
    return this.readThreadImpl(threadId);
  }

  override rollbackThread(threadId: ThreadId, numTurns: number) {
    return this.rollbackThreadImpl(threadId, numTurns);
  }

  override respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    return this.respondToRequestImpl(threadId, requestId, decision);
  }

  override respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    return this.respondToUserInputImpl(threadId, requestId, answers);
  }

  override stopSession(_threadId: ThreadId): void {}

  override listSessions(): ProviderSession[] {
    return [];
  }

  override hasSession(_threadId: ThreadId): boolean {
    return false;
  }

  override stopAll(): void {
    this.stopAllImpl();
  }
}

export const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  remove: () => Effect.void,
  listThreadIds: () => Effect.succeed([]),
});
