import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { dispatchRaceFixture } from "./TextGeneration.dispatch.fixture.ts";
import { maybeGenerateThreadElevatorSummary } from "../../orchestration/Layers/ProviderCommandReactorHandlers.elevatorSummary.ts";
import { maybeGenerateAndRenameWorktreeBranchForFirstTurn } from "../../orchestration/Layers/ProviderCommandReactorSessionOps.firstTurn.ts";
import { textGenerationSelection } from "../../provider/Layers/OpencodeV2/TextGeneration.fixture.ts";

const paid = (f: Awaited<ReturnType<typeof dispatchRaceFixture>>) =>
  f.http.requests.filter(({ pathname }) => pathname.endsWith("/generate")).length;
function run(f: Awaited<ReturnType<typeof dispatchRaceFixture>>, operation: "summary" | "branch") {
  return operation === "summary"
    ? maybeGenerateThreadElevatorSummary(f.services())({ threadId: f.state.thread.id, force: true })
    : maybeGenerateAndRenameWorktreeBranchForFirstTurn(f.services())({
        threadId: f.state.thread.id,
        branch: "bigbud/12345678",
        worktreePath: "/fixture",
        messageText: "Repair native routing",
      });
}

it.each(["summary", "branch"] as const)(
  "%s persists authoritative V2 ownership before dispatch despite a changed preference, and survives interruption/restart",
  async (operation) => {
    for (const mode of ["preference-change", "fallback"] as const) {
      const f = await dispatchRaceFixture(mode),
        controller = new AbortController();
      const running = Effect.runPromiseExit(run(f, operation), { signal: controller.signal });
      try {
        await vi.waitFor(() => expect(paid(f)).toBe(1));
        expect(
          f.atDispatch[0]?.some(
            (item) =>
              item.kind === "text-generation.started" &&
              (item.payload as { uncertaintyProtected?: boolean }).uncertaintyProtected,
          ),
        ).toBe(true);
        expect(
          f.atDispatch[0]?.findLast((item) => item.kind === "text-generation.started")?.payload,
        ).toMatchObject({
          operation,
          uncertaintyProtected: true,
          modelSelection: textGenerationSelection,
        });
        controller.abort();
        await running;
        f.restoreNative();
        f.restartRouter();
        await Effect.runPromise(run(f, operation));
        await Effect.runPromise(run(f, operation));
        expect(paid(f)).toBe(1);
        expect(f.http.sessions.size).toBe(1);
        expect(f.ordinaryCalls()).toBe(mode === "fallback" ? 1 : 0);
      } finally {
        controller.abort();
        await running;
        f.finishAll();
      }
    }
  },
);

it.each(["preference-change", "fallback"] as const)(
  "suggestion %s ownership survives interruption/restart without blocking a new human-turn job",
  async (mode) => {
    const f = await dispatchRaceFixture(mode);
    let reactor = await f.startSuggestions();
    try {
      await reactor.publish();
      await vi.waitFor(() => expect(paid(f)).toBe(1));
      expect(
        f.atDispatch[0]?.findLast((item) => item.kind === "text-generation.started")?.payload,
      ).toMatchObject({
        operation: "promptSuggestion",
        uncertaintyProtected: true,
        modelSelection: textGenerationSelection,
        turnId: "dispatch-race-turn",
      });
      await reactor.stop();
      f.restoreNative();
      f.restartRouter();
      reactor = await f.startSuggestions();
      await reactor.publish();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(paid(f)).toBe(1);
      f.nextTurn();
      await reactor.publish();
      await vi.waitFor(() => expect(paid(f)).toBe(2));
      f.finish(1);
      await vi.waitFor(() => expect(f.http.sessions.size).toBe(1));
    } finally {
      await reactor.stop();
      f.finishAll();
    }
  },
);

it.each(["summary", "branch"] as const)(
  "ordinary non-V2 %s failures remain retryable without native ownership claims",
  async (operation) => {
    const f = await dispatchRaceFixture("ordinary");
    await Effect.runPromise(run(f, operation));
    await Effect.runPromise(run(f, operation));
    expect(f.ordinaryCalls()).toBeGreaterThanOrEqual(2);
    expect(
      f.state.thread.activities.some(
        (item) => (item.payload as { uncertaintyProtected?: boolean } | null)?.uncertaintyProtected,
      ),
    ).toBe(false);
    expect(paid(f)).toBe(0);
  },
);
