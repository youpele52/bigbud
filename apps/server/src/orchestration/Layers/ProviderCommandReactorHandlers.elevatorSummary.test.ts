import { MessageId, ProjectId, ThreadId, TextGenerationError } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  countVisibleSummaryMessages,
  maybeGenerateThreadElevatorSummary,
  shouldRefreshThreadElevatorSummary,
} from "./ProviderCommandReactorHandlers.elevatorSummary.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.ts";

function makeMessage(id: string, role: "user" | "assistant" | "system") {
  return {
    id: MessageId.makeUnsafe(id),
    role,
    text: `${role} message`,
    turnId: null,
    streaming: false,
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
  };
}

function makeThread(input?: {
  readonly elevatorSummaryMessageCount?: number;
  readonly messageRoles?: ReadonlyArray<"user" | "assistant" | "system">;
  readonly archivedAt?: string | null;
  readonly deletingAt?: string | null;
  readonly deletedAt?: string | null;
}) {
  return {
    archivedAt: input?.archivedAt ?? null,
    deletingAt: input?.deletingAt ?? null,
    deletedAt: input?.deletedAt ?? null,
    elevatorSummaryMessageCount: input?.elevatorSummaryMessageCount ?? 0,
    messages: (input?.messageRoles ?? []).map((role, index) =>
      makeMessage(`message-${index + 1}`, role),
    ),
  };
}

describe("ProviderCommandReactorHandlers.elevatorSummary", () => {
  it("counts only user and assistant messages", () => {
    expect(
      countVisibleSummaryMessages([
        makeMessage("message-1", "user"),
        makeMessage("message-2", "system"),
        makeMessage("message-3", "assistant"),
      ]),
    ).toBe(2);
  });

  it("waits for five visible messages before the first summary generation", () => {
    expect(
      shouldRefreshThreadElevatorSummary({
        thread: makeThread({
          messageRoles: ["user", "assistant", "user", "assistant"],
        }),
      }),
    ).toBe(false);

    expect(
      shouldRefreshThreadElevatorSummary({
        thread: makeThread({
          messageRoles: ["user", "assistant", "system", "user", "assistant", "user"],
        }),
      }),
    ).toBe(true);
  });

  it("refreshes only after ten more visible messages once a summary exists", () => {
    expect(
      shouldRefreshThreadElevatorSummary({
        thread: makeThread({
          elevatorSummaryMessageCount: 5,
          messageRoles: Array.from({ length: 14 }, () => "user"),
        }),
      }),
    ).toBe(false);

    expect(
      shouldRefreshThreadElevatorSummary({
        thread: makeThread({
          elevatorSummaryMessageCount: 5,
          messageRoles: Array.from({ length: 15 }, () => "assistant"),
        }),
      }),
    ).toBe(true);
  });

  it("skips archived, deleting, and deleted threads", () => {
    expect(
      shouldRefreshThreadElevatorSummary({
        thread: makeThread({
          archivedAt: "2026-07-05T00:00:00.000Z",
          messageRoles: Array.from({ length: 15 }, () => "user"),
        }),
      }),
    ).toBe(false);
    expect(
      shouldRefreshThreadElevatorSummary({
        thread: makeThread({
          deletingAt: "2026-07-05T00:00:00.000Z",
          messageRoles: Array.from({ length: 15 }, () => "assistant"),
        }),
      }),
    ).toBe(false);
    expect(
      shouldRefreshThreadElevatorSummary({
        thread: makeThread({
          deletedAt: "2026-07-05T00:00:00.000Z",
          messageRoles: Array.from({ length: 15 }, () => "user"),
        }),
      }),
    ).toBe(false);
  });

  it("does not replace the title-based default summary when provider generation fails", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread-1");
        const dispatch = vi.fn(() => Effect.void);
        const thread = {
          ...makeThread({
            messageRoles: ["user", "assistant", "user", "assistant", "user"],
          }),
          id: threadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Tooltip missing",
          elevatorSummary: "Tooltip missing",
          modelSelection: {
            provider: "opencode",
            model: "test-model",
          },
          worktreePath: "/tmp/project",
        };
        const services = {
          resolveThread: () => Effect.succeed(thread),
          serverSettingsService: {
            getSettings: Effect.succeed({}),
          },
          orchestrationEngine: {
            getReadModel: () =>
              Effect.succeed({
                projects: [],
              }),
            dispatch,
          },
          textGeneration: {
            generateThreadElevatorSummary: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: "generateThreadElevatorSummary",
                  detail: "Provider auth failed",
                }),
              ),
          },
        } as unknown as SessionOpServices;

        yield* maybeGenerateThreadElevatorSummary(services)({ threadId });

        expect(dispatch).not.toHaveBeenCalled();
      }),
    );
  });
});
