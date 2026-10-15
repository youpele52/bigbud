import { CommandId, EventId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import {
  autoForkThreadId,
  isUnprovenAutomaticFork,
} from "./ProviderCommandReactorHandlers.fork.ts";
import {
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";
import {
  completeFirstTurn,
  dispatchTurn,
  failures,
  sendInput,
  sessionDead,
  sourceSends,
  THREAD,
} from "./ProviderCommandReactor.sessionRecovery.test.helpers.ts";

type Harness = Awaited<ReturnType<typeof createHarness>>;
const threads = async (harness: Harness) =>
  (await Effect.runPromise(harness.engine.getReadModel())).threads;
const forks = async (harness: Harness) =>
  (await threads(harness)).filter((thread) => thread.parentThread?.threadId === THREAD);
const quiet = () => new Promise((resolve) => setTimeout(resolve, 400));

describe("ProviderCommandReactor automatic fork fallback", () => {
  registerProviderCommandReactorTestCleanup();

  it("forks once after in-place recovery is exhausted and sends the never-admitted message", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementation(sessionDead as never);
    await dispatchTurn(harness, "second", "second question");
    await waitFor(async () => (await forks(harness)).length > 0);
    await waitFor(async () =>
      (await forks(harness)).some((thread) =>
        thread.activities.some((entry) => entry.kind === "provider.turn.start.failed"),
      ),
    );
    await quiet();

    const created = await forks(harness);
    expect(created).toHaveLength(1);
    // The fork's own failure never forks again (no fork of the fork, whatever the clocks say).
    expect((await threads(harness)).filter((thread) => thread.forkOrigin)).toHaveLength(1);
    const fork = created[0]!;
    const failure = (await failures(harness))[0]!;
    expect(fork.id).toBe(autoForkThreadId(THREAD, failure.id));
    // The failure names its own message, so delivery never borrows another message's class.
    expect(failure.payload).toMatchObject({ messageId: "user-second" });
    expect(fork.forkOrigin).toMatchObject({
      reason: "recovery-failed",
      failureEventId: failure.id,
      pendingDelivery: "sent",
    });
    expect(fork.modelSelection.provider).toBe("codex");
    // The fork replays its copied transcript and the pending message.
    const forkSend = sendInput(harness, harness.sendTurn.mock.calls.length - 1);
    expect(forkSend).toContain("first answer");
    expect(forkSend).toContain("second question");
  });

  it("forks at most once while the source stays dead; later failed sends keep that fork", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementation(sessionDead as never);
    await dispatchTurn(harness, "second", "second question");
    await waitFor(async () => (await forks(harness)).length > 0);
    await quiet();
    await dispatchTurn(harness, "third", "third question");
    await waitFor(async () => (await failures(harness)).length > 1);
    await quiet();

    expect(await forks(harness)).toHaveLength(1);
    // The later message stays in the source; the user decides whether it follows the fork.
    const fork = (await forks(harness))[0]!;
    expect(fork.messages.some((message) => message.text === "third question")).toBe(false);
  });

  it("forks once more after the user deleted the automatic fork", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementation(sessionDead as never);
    await dispatchTurn(harness, "second", "second question");
    await waitFor(async () => (await forks(harness)).length > 0);
    await quiet();
    const deleted = (await forks(harness))[0]!;
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-delete-fork"),
        threadId: deleted.id,
      }),
    );
    const live = async () => (await forks(harness)).filter((thread) => thread.deletedAt === null);
    await waitFor(async () => (await live()).length === 0);
    await dispatchTurn(harness, "third", "third question");
    await waitFor(async () => (await live()).length > 0);
    await quiet();

    const replacement = await live();
    expect(replacement).toHaveLength(1);
    expect(replacement[0]?.id).not.toBe(deleted.id);
  });

  it("never forks an automatic fork again before it answered on its own (clock-independent)", () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const fork = {
      createdAt: new Date().toISOString(),
      forkOrigin: { forkPointMessageId: null, reason: "recovery-failed", failureEventId: null },
      // Copied history carries turnId null, even when its timestamps are later than the fork's.
      messages: [{ role: "assistant", turnId: null, createdAt: future }],
    } as never;
    expect(isUnprovenAutomaticFork(fork)).toBe(true);
    const answered = { ...(fork as object), messages: [{ role: "assistant", turnId: "turn-9" }] };
    expect(isUnprovenAutomaticFork(answered as never)).toBe(false);
    const manual = { ...(fork as object), forkOrigin: { reason: "manual" } };
    expect(isUnprovenAutomaticFork(manual as never)).toBe(false);
  });

  it("is idempotent for redelivered and concurrent fork commands of one failure", async () => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    const failureEventId = EventId.makeUnsafe("turn-start-failed:manual-test");
    // A redelivery repeats the identical command, so the payload (and digest) matches.
    const createdAt = new Date().toISOString();
    const fork = (commandId: string, threadId: string) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.fork",
          commandId: CommandId.makeUnsafe(commandId),
          sourceThreadId: THREAD,
          threadId: ThreadId.makeUnsafe(threadId),
          reason: "manual",
          failureEventId,
          createdAt,
        }),
      );
    await Promise.all([fork("cmd-a", "fork-a"), fork("cmd-b", "fork-b"), fork("cmd-a", "fork-a")]);
    await quiet();
    expect(await forks(harness)).toHaveLength(1);
  });

  it.each([
    ["auth-or-quota", "401 Unauthorized: invalid API key"],
    ["unsafe-to-replay", "Turn admission may be unconfirmed; nothing was replayed."],
    ["provider-unavailable", "spawn codex ENOENT"],
  ])("never recovers or forks automatically for %s failures", async (failureClass, detail) => {
    const harness = await createHarness({ sessionRecovery: "resume-restart" });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementation((() =>
      Effect.fail(
        new ProviderAdapterRequestError({ provider: "codex", method: "turn/start", detail }),
      )) as never);
    await dispatchTurn(harness, "second", "second question");
    await waitFor(async () => (await failures(harness)).length > 0);
    await quiet();
    expect(await forks(harness)).toHaveLength(0);
    expect((await failures(harness))[0]?.payload).toMatchObject({ failureClass });
    expect(sourceSends(harness)).toHaveLength(2); // first turn + the failed attempt, no recovery
  });
});
