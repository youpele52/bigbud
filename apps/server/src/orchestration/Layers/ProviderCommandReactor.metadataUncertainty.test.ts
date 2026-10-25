import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import { EventId } from "@bigbud/contracts/core/baseSchemas";
import { titleFixture } from "./ProviderCommandReactorSessionOps.title.fixture.ts";
import { maybeGenerateThreadElevatorSummary } from "./ProviderCommandReactorHandlers.elevatorSummary.ts";
import { maybeGenerateAndRenameWorktreeBranchForFirstTurn } from "./ProviderCommandReactorSessionOps.firstTurn.ts";
import { requestTextGenerationRetry } from "../../ws/wsRetryTextGeneration.ts";
import { recordThreadTextGenerationStatusRequired } from "../../git/Layers/InternalTextGeneration.status.ts";

const uncertain = () =>
  Effect.fail(
    new TextGenerationError({
      operation: "metadata",
      kind: "uncertain",
      uncertaintyId: "ses_retained_auxiliary",
      detail: "Native dispatch is unconfirmed.",
    }),
  );

it.each(["summary", "branch"] as const)(
  "%s metadata generation preserves uncertainty and does not replay a paid job",
  async (operation) => {
    const f = titleFixture();
    for (let index = 1; index <= 5; index++) f.addSuccess(index);
    const generate = vi.fn(uncertain);
    const services = {
      ...f.services,
      resolveThread: () => Effect.succeed({ ...f.thread, branch: "bigbud/12345678" }),
      textGeneration: {
        ...f.services.textGeneration,
        generateThreadElevatorSummary: generate,
        generateBranchName: generate,
      },
    };
    const run = () =>
      operation === "summary"
        ? maybeGenerateThreadElevatorSummary(services)({ threadId: f.thread.id, force: true })
        : maybeGenerateAndRenameWorktreeBranchForFirstTurn(services)({
            threadId: f.thread.id,
            branch: "bigbud/12345678",
            worktreePath: "/fixture",
            messageText: "Repair routing",
          });
    await Effect.runPromise(run());
    await Effect.runPromise(run());
    expect(generate).toHaveBeenCalledTimes(1);
    expect(
      f.thread.activities.find((item) => item.kind === "text-generation.uncertain")?.payload,
    ).toMatchObject({ operation, uncertaintyId: "ses_retained_auxiliary" });
  },
);

it("a persisted protected summary claim prevents replay after backend restart, including explicit retries", async () => {
  const f = titleFixture();
  for (let index = 1; index <= 5; index++) f.addSuccess(index);
  const generate = vi.fn(() => Effect.succeed({ summary: "Must not be paid again" }));
  const services = {
    ...f.services,
    textGeneration: { ...f.services.textGeneration, generateThreadElevatorSummary: generate },
  };
  await Effect.runPromise(
    recordThreadTextGenerationStatusRequired(
      f.services.orchestrationEngine,
      f.thread.id,
      "summary",
      "started",
      { uncertaintyProtected: true },
    ),
  );
  await Effect.runPromise(
    maybeGenerateThreadElevatorSummary(services)({ threadId: f.thread.id, force: true }),
  );
  expect(generate).not.toHaveBeenCalled();
  const error = await Effect.runPromise(
    requestTextGenerationRetry(f.services.orchestrationEngine, {
      threadId: f.thread.id,
      operation: "summary",
      sourceActivityId: EventId.makeUnsafe("any-old-failure"),
    }).pipe(Effect.flip),
  );
  expect(error.kind).toBe("uncertain");
});
