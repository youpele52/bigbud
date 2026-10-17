import { MessageId, ProjectId, ThreadId, TextGenerationError } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  countVisibleSummaryMessages,
  buildElevatorSummaryTranscript,
  maybeGenerateThreadElevatorSummary,
  shouldRefreshThreadElevatorSummary,
} from "./ProviderCommandReactorHandlers.elevatorSummary.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";

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
  it("retains recent user intent when the newest assistant response exceeds the context budget", () => {
    const context = buildElevatorSummaryTranscript([
      { ...makeMessage("intent", "user"), text: "Fix the session reconnect regression" },
      { ...makeMessage("oversized", "assistant"), text: "A".repeat(8_001) },
    ]);
    expect(context.length).toBeGreaterThan(0);
    expect(context.length).toBeLessThanOrEqual(8_000);
    expect(context).toContain("USER:\nFix the session reconnect regression");
    expect(context).toContain("ASSISTANT:\nA");
  });
  it.each(["user", "assistant"] as const)(
    "bounds an oversized standalone %s message without losing all context",
    (role) => {
      const context = buildElevatorSummaryTranscript([
        { ...makeMessage("oversized", role), text: "😀".repeat(8_001) },
      ]);
      expect(context.length).toBeGreaterThan(0);
      expect(context.length).toBeLessThanOrEqual(8_000);
      expect(context).not.toMatch(/[\uD800-\uDFFF]/u);
    },
  );
  it("reserves user intent even behind multiple oversized assistant responses", () => {
    const context = buildElevatorSummaryTranscript([
      { ...makeMessage("intent", "user"), text: "Preserve my latest user request" },
      { ...makeMessage("assistant-1", "assistant"), text: "B".repeat(8_001) },
      { ...makeMessage("assistant-2", "assistant"), text: "😀".repeat(8_001) },
    ]);
    expect(context).toContain("Preserve my latest user request");
    expect(context.length).toBeLessThanOrEqual(8_000);
    expect(context).not.toMatch(/[\uD800-\uDFFF]/u);
  });
  it("reads meaningful user intent after a large whitespace prefix without copying the whole message", () => {
    const context = buildElevatorSummaryTranscript([
      { ...makeMessage("intent", "user"), text: `${" ".repeat(8_001)}Fix reconnects` },
    ]);
    expect(context).toBe("USER:\nFix reconnects");
  });
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
          activities: [],
        };
        const services = {
          resolveThread: () => Effect.succeed(thread),
          serverSettingsService: {
            getSettings: Effect.succeed({
              textGenerationModelSelection: { provider: "codex", model: "explicit-model" },
            }),
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

        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "thread.activity.append",
            activity: expect.objectContaining({
              kind: "text-generation.failed",
              payload: { operation: "summary" },
            }),
          }),
        );
        expect(dispatch).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: "thread.meta.update" }),
        );
      }),
    );
  });
});
