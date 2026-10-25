import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { MessageId, ThreadId, TurnId } from "@bigbud/contracts";
import { recordSubmittedUserTurn } from "./ProviderCommandReactorSessionOps.userTurn.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";

describe("user turn success threshold binding", () => {
  it.each(["user", "assistant", "missing"])(
    "binds only submitted persisted user messages (%s)",
    async (role) => {
      const id = MessageId.makeUnsafe("submitted");
      const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
      const services = {
        orchestrationEngine: { dispatch },
        resolveThread: () => Effect.succeed({ messages: role === "missing" ? [] : [{ id, role }] }),
      } as unknown as SessionOpServices;
      await Effect.runPromise(
        recordSubmittedUserTurn(services, {
          threadId: ThreadId.makeUnsafe("thread"),
          requestMessageId: id,
          turnId: TurnId.makeUnsafe("actual-turn"),
          createdAt: "2026-10-17T00:00:00.000Z",
          providerIdle: false,
        }),
      );
      expect(dispatch).toHaveBeenCalledTimes(role === "user" ? 1 : 0);
      if (role === "user")
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            activity: expect.objectContaining({
              kind: "text-generation.user-turn-bound",
              turnId: "actual-turn",
              payload: { messageId: id, providerIdle: false },
            }),
          }),
        );
    },
  );
});
