import { MessageId, ThreadId, TurnId } from "@bigbud/contracts";
import { Effect, Exit, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { provenBeforeDispatch } from "../../orchestration/Layers/ProviderCommandReactorSessionOps.recovery.dispatch.phase.ts";
import { isResendableTurnStartFailure } from "../../orchestration/Layers/ProviderCommandReactorSessionOps.recovery.dispatch.ts";
import { classifyTurnStartFailure } from "../../orchestration/Layers/ProviderTurnFailureClassification.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { ProviderDispatchAttemptPersistenceError } from "../Errors.ts";
import type {
  ProviderDispatchAttempt,
  ProviderDispatchAttemptRepositoryShape,
} from "../../persistence/Services/ProviderDispatchAttempts.ts";
import type { ProviderTurnLivenessRepositoryShape } from "../../persistence/Services/ProviderTurnLiveness.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import type { ResolveRoutableSession } from "./ProviderService.operations.ts";
import { dispatchPayloadDigest, makeSendTurn } from "./ProviderService.sendTurn.ts";

const threadId = ThreadId.makeUnsafe("send-thread");
const messageId = MessageId.makeUnsafe("send-message");
const turnId = TurnId.makeUnsafe("send-turn");

function makeHarness(options: { readonly failMark?: boolean; readonly markDetail?: string } = {}) {
  const calls: string[] = [];
  const adapter = {
    provider: "codex" as const,
    sendTurn: vi.fn(() => {
      calls.push("adapter.sendTurn");
      return Effect.succeed({ threadId, turnId });
    }),
    listSessions: () => Effect.succeed([]),
  };
  const resolveRoutableSession = (() =>
    Effect.succeed({ adapter, threadId, isActive: true })) as unknown as ResolveRoutableSession;
  const attempt: ProviderDispatchAttempt = {
    attemptId: "attempt-1",
    threadId,
    messageId,
    intentRevision: 0,
    payloadDigest: "digest",
    provider: "codex",
    turnId: null,
    state: "may-have-been-sent",
    preparedAt: "2026-10-22T10:00:00.000Z",
    mayHaveBeenSentAt: "2026-10-22T10:00:00.000Z",
    acknowledgedAt: null,
    updatedAt: "2026-10-22T10:00:00.000Z",
  };
  const attempts: ProviderDispatchAttemptRepositoryShape = {
    markMayHaveBeenSent: () => {
      calls.push("markMayHaveBeenSent");
      return options.failMark
        ? Effect.fail(
            new PersistenceSqlError({
              operation: "test",
              detail: options.markDetail ?? "disk full",
            }),
          )
        : Effect.succeed(Option.some(attempt));
    },
    acknowledgeWith: (_input, alongside) =>
      alongside.pipe(Effect.tap(() => Effect.sync(() => calls.push("acknowledged")))),
    latestForIntent: () => Effect.succeed(Option.none()),
  };
  const liveness = {
    startTurn: () => Effect.sync(() => calls.push("liveness.startTurn")),
  } as unknown as ProviderTurnLivenessRepositoryShape;
  const directory = {
    upsert: () => Effect.sync(() => calls.push("directory.upsert")),
  } as unknown as ProviderSessionDirectoryShape;
  const sendTurn = makeSendTurn({
    resolveRoutableSession,
    directory,
    liveness: Option.some(liveness),
    dispatchAttempts: Option.some(attempts),
    analytics: { record: () => Effect.void, flush: Effect.void } as never,
  });
  return { sendTurn, calls, adapter };
}

describe("ProviderService.sendTurn dispatch attempts", () => {
  it("makes may-have-been-sent durable before the adapter call, and acknowledges after", async () => {
    const { sendTurn, calls } = makeHarness();
    await Effect.runPromise(sendTurn({ threadId, requestMessageId: messageId, input: "hello" }));
    expect(calls).toEqual([
      "markMayHaveBeenSent",
      "adapter.sendTurn",
      "liveness.startTurn",
      "directory.upsert",
      "acknowledged",
    ]);
  });

  it("does not send when the may-have-been-sent write fails", async () => {
    const { sendTurn, calls, adapter } = makeHarness({ failMark: true });
    const exit = await Effect.runPromise(
      Effect.exit(sendTurn({ threadId, requestMessageId: messageId, input: "hello" })),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(adapter.sendTurn).not.toHaveBeenCalled();
    expect(calls).toEqual(["markMayHaveBeenSent"]);
  });

  it("reports a failed may-have-been-sent write as proven before dispatch", async () => {
    const { sendTurn } = makeHarness({ failMark: true, markDetail: "database connection closed" });
    const error = await Effect.runPromise(
      Effect.flip(sendTurn({ threadId, requestMessageId: messageId, input: "hello" })),
    );
    expect(error).toBeInstanceOf(ProviderDispatchAttemptPersistenceError);
    // The reactor marks the phase dispatched just before calling sendTurn.
    const phase = { dispatched: true };
    expect(provenBeforeDispatch(error, phase)).toBe(true);
    expect(classifyTurnStartFailure(error, phase)).not.toBe("unsafe-to-replay");
    expect(isResendableTurnStartFailure(error, phase)).toBe(true);
  });

  it("does not track sends without a request message", async () => {
    const { sendTurn, calls } = makeHarness();
    await Effect.runPromise(sendTurn({ threadId, input: "internal" }));
    expect(calls[0]).toBe("adapter.sendTurn");
    expect(calls).not.toContain("acknowledged");
  });

  it("digests the sent payload stably", () => {
    const digest = dispatchPayloadDigest({ input: "hi", attachments: [] });
    expect(digest).toBe(dispatchPayloadDigest({ input: "hi", attachments: [] }));
    expect(digest).not.toBe(dispatchPayloadDigest({ input: "hello", attachments: [] }));
  });
});
