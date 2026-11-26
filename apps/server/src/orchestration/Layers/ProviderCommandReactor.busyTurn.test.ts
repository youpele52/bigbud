import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ThreadId,
  type ModelSelection,
  type ProviderKind,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../../provider/Errors.ts";
import type { OrchestrationThread } from "@bigbud/contracts";
import {
  asMessageId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";
import { settleActiveTurn } from "./ProviderCommandReactor.test.settleTurn.ts";

const userMessageIds = (thread: OrchestrationThread | undefined) =>
  (thread?.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => message.id);

describe("ProviderCommandReactor busy turn recovery", () => {
  registerProviderCommandReactorTestCleanup();

  it("does not requeue an ACP prompt that reports busy after dispatch", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "cursor", model: "fake-model" },
    });
    const deliverTurn = harness.sendTurn.getMockImplementation()!;
    harness.sendTurn.mockImplementationOnce(
      (input: unknown) =>
        Effect.andThen(
          deliverTurn(input),
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: "cursor",
              method: "session/prompt",
              detail: "A turn is already active; cannot start another turn.",
            }),
          ),
        ) as never,
    );
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-busy-turn-follow-up"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("busy-follow-up"),
          role: "user",
          text: "Please continue when the current work is finished.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ===
        true
      );
    });
    await settleActiveTurn(harness.engine, "cmd-settle-busy-turn", new Date().toISOString(), {
      providerName: "cursor",
      runtimeMode: "full-access",
    });
    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
    expect(userMessageIds(thread)).toEqual(["busy-follow-up"]);
    expect(thread?.queuedPrompts ?? []).toEqual([]);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  const exactProviders = [
    "claudeAgent",
    "cliProxy",
    "codex",
    "copilot",
    "cursor",
    "devin",
    "muse",
  ] as const;
  it.each(
    exactProviders.flatMap((provider) =>
      [false, true].map((closedFirst) => [provider, closedFirst] as const),
    ),
  )(
    "safely parks a %s no-live-turn refusal (resolved before park: %s)",
    async (provider, closedFirst) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model: "fake-model" } as ModelSelection,
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const messageId = asMessageId("recoverable-follow-up");
      const approval = ApprovalRequestId.makeUnsafe("no-live-approval");
      const question = ApprovalRequestId.makeUnsafe("no-live-question");
      const epoch = 1;
      const closure = (
        kind: string,
        requestId: string,
        interactionSessionEpoch = epoch,
        requestGeneration = "generation",
        interactionProvider: ProviderKind = provider,
      ) => {
        const id = `${kind}:${requestId}:${interactionSessionEpoch}:${requestGeneration}:${interactionProvider}`;
        const createdAt = new Date().toISOString();
        return harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(id),
          threadId,
          createdAt,
          activity: {
            id: EventId.makeUnsafe(id),
            kind,
            summary: kind,
            tone: "info",
            turnId: null,
            createdAt,
            payload: {
              requestId,
              interactionProvider,
              interactionSessionEpoch,
              requestGeneration,
            },
          },
        });
      };
      const refusal = new ProviderAdapterValidationError({
        provider,
        operation: "sendTurn",
        issue: "Pending provider interaction",
        failureClass: "invalid-request",
        turnStartRefusal: {
          kind: "pending-interaction",
          gate: {
            provider,
            sessionEpoch: epoch,
            approvalRequests: [{ requestId: approval, generation: "generation" }],
            userInputRequests: [{ requestId: question, generation: "generation" }],
          },
        },
      });
      harness.sendTurn.mockImplementationOnce(
        () =>
          Effect.gen(function* () {
            if (closedFirst) {
              yield* closure("approval.resolved", approval);
              yield* closure("user-input.resolved", question);
            }
            return yield* refusal;
          }) as never,
      );
      const read = async () => (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-no-live-turn"),
          threadId,
          message: { messageId, role: "user", text: "Keep this message", attachments: [] },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: new Date().toISOString(),
        }),
      );
      if (!closedFirst) {
        await waitFor(
          async () => (await read())?.queuedPrompts?.[0]?.pendingInteractionGate !== undefined,
        );
        expect((await read())?.queuedPrompts).toMatchObject([
          {
            id: messageId,
            alreadySent: true,
            pendingInteractionGate: refusal.turnStartRefusal?.gate,
          },
        ]);
        const manual = harness.engine.dispatch({
          type: "thread.queued-prompt.flush",
          threadId,
          commandId: CommandId.makeUnsafe("manual-before-close"),
          messageIds: [messageId],
          messageId,
          userRelease: true,
          createdAt: new Date().toISOString(),
        });
        await expect(Effect.runPromise(manual)).rejects.toMatchObject({
          code: "queue_waiting_for_user",
        });
        await Effect.runPromise(closure("provider.approval.respond.failed", approval));
        await Effect.runPromise(closure("approval.resolved", approval, epoch + 1));
        await Effect.runPromise(
          closure(
            "approval.resolved",
            approval,
            epoch,
            "generation",
            provider === "codex" ? "claudeAgent" : "codex",
          ),
        );
        await Effect.runPromise(closure("approval.resolved", approval, epoch, "stale-generation"));
        await Effect.runPromise(closure("user-input.resolved", approval));
        expect((await read())?.queuedPrompts?.[0]?.pendingInteractionGate).toEqual(
          refusal.turnStartRefusal?.gate,
        );
        await Effect.runPromise(closure("approval.resolved", approval));
        expect((await read())?.queuedPrompts?.[0]?.pendingInteractionGate).toMatchObject({
          approvalRequests: [],
          userInputRequests: [{ requestId: question, generation: "generation" }],
        });
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        await Effect.runPromise(closure("user-input.resolved", question));
      }
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      const delivered = await read();
      expect(userMessageIds(delivered)).toEqual([messageId]);
      expect(delivered?.queuedPrompts ?? []).toEqual([]);
      expect(
        harness.sendTurn.mock.calls.map(
          ([input]) => (input as { requestMessageId?: string }).requestMessageId,
        ),
      ).toEqual([messageId, messageId]);
    },
  );
});
