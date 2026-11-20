/**
 * Recovery rows (WP-5D): disconnect + replay and duplicate receipt. The checks are pure
 * functions over replayed events so they are tested directly; the runners only collect them.
 */
import { prompt } from "./rows.ts";
import { FULL_ACCESS, withThread, type ProviderContext, type RowOutcome } from "./rows.context.ts";
import {
  assistantText,
  containsToken,
  delay,
  dispatch,
  errorText,
  isSettled,
  reduceThread,
  replayAll,
  turnStartCommand,
  waitForView,
  type ReplayPage,
  type ReplayedEvent,
} from "./session.ts";

/** Strictly increasing sequences and unique event ids: no duplicates, no reordering. */
export function orderingProblems(events: ReadonlyArray<ReplayedEvent>): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (index > 0 && event.sequence <= events[index - 1]!.sequence)
      problems.push(`sequence ${event.sequence} not after ${events[index - 1]!.sequence}`);
    if (ids.has(event.eventId)) problems.push(`event ${event.sequence} replayed twice`);
    ids.add(event.eventId);
  }
  return problems;
}

const userMessages = (events: ReadonlyArray<ReplayedEvent>, messageId: string) =>
  events.filter(
    (event) =>
      event.type === "thread.message-sent" &&
      event.payload.messageId === messageId &&
      event.payload.role === "user",
  ).length;

/**
 * After a client vanished mid-turn, a new client's replay from the pre-turn cursor must be
 * available, ordered, idempotent (two replays agree), carry the user message once, settle the
 * turn exactly once as `completed`, and contain the reply.
 */
export function checkReplay(input: {
  readonly threadId: string;
  readonly messageId: string;
  readonly token: string;
  readonly first: ReplayPage;
  readonly second: ReplayPage;
}): RowOutcome {
  const own = (page: ReplayPage) => page.events.filter((e) => e.aggregateId === input.threadId);
  const first = own(input.first);
  const second = own(input.second);
  const view = reduceThread(first, input.threadId);
  const problems = [
    ...(input.first.availability === "available" ? [] : ["replay reported a gap"]),
    ...orderingProblems(first),
    ...(first.map((e) => e.eventId).join() === second.map((e) => e.eventId).join()
      ? []
      : ["two replays from the same cursor differ"]),
    ...(userMessages(first, input.messageId) === 1
      ? []
      : ["user message not replayed exactly once"]),
    ...(view.settled.length === 1 ? [] : [`turn settled ${view.settled.length} times`]),
    ...(view.settled[0]?.outcome === "completed" || view.settled.length !== 1
      ? []
      : [`turn settled ${view.settled[0]?.outcome}`]),
    ...(containsToken(assistantText(view), input.token) ? [] : ["reply missing from the replay"]),
  ];
  const evidence = { replayedEvents: first.length, settledCount: view.settled.length };
  return problems.length === 0
    ? { status: "pass", reason: "replay after reconnect is complete and idempotent", evidence }
    : { status: "fail", reason: problems.join("; "), evidence };
}

export const disconnectReplayRow = (context: ProviderContext) =>
  withThread(context, "disconnect-replay", FULL_ACCESS, async (thread) => {
    const command = turnStartCommand({
      threadId: thread.threadId,
      provider: context.provider,
      model: context.model,
      text: prompt("replay", context.tokens.replay),
      ...FULL_ACCESS,
    });
    // Client A starts the turn and vanishes once the turn is visibly running.
    const clientA = await context.backend.connect();
    try {
      await dispatch(clientA, command);
      await waitForView(clientA, thread, context.timing, (view) => view.events.length > 1);
    } finally {
      clientA.close();
    }
    await delay(context.timing.disconnectMs);
    // Client B is a fresh connection that only replays.
    const clientB = await context.backend.connect();
    try {
      const settled = await waitForView(clientB, thread, context.timing, isSettled);
      if (!settled.met)
        return { status: "fail", reason: "turn did not settle after the disconnect" };
      const first = await replayAll(clientB, thread.cursor);
      const second = await replayAll(clientB, thread.cursor);
      return checkReplay({
        threadId: thread.threadId,
        messageId: command.message.messageId,
        token: context.tokens.replay,
        first,
        second,
      });
    } finally {
      clientB.close();
    }
  });

export interface DuplicateObservation {
  readonly firstSequence: unknown;
  readonly retrySequence: unknown;
  readonly outcomeStatus: unknown;
  readonly outcomeSequence: unknown;
  /** Error text from re-sending the same commandId with a different payload, or null. */
  readonly conflictError: string | null;
  readonly userMessageCount: number;
  readonly turnStartRequests: number;
  readonly settledCount: number;
}

/**
 * The same commandId sent again (after a reconnect) must return the stored receipt, not run a
 * second turn; a different payload under that commandId must be refused.
 */
export function checkDuplicate(observed: DuplicateObservation): RowOutcome {
  const problems = [
    ...(typeof observed.firstSequence === "number" &&
    observed.retrySequence === observed.firstSequence
      ? []
      : ["retry did not return the original receipt sequence"]),
    ...(observed.outcomeStatus === "accepted" && observed.outcomeSequence === observed.firstSequence
      ? []
      : ["command outcome is not the accepted original"]),
    ...(observed.conflictError === null ? ["conflicting payload was accepted"] : []),
    ...(observed.userMessageCount === 1 ? [] : [`${observed.userMessageCount} user messages`]),
    ...(observed.turnStartRequests === 1 ? [] : [`${observed.turnStartRequests} turn starts`]),
    ...(observed.settledCount === 1 ? [] : [`${observed.settledCount} settled turns`]),
  ];
  const evidence = {
    userMessages: observed.userMessageCount,
    turnStarts: observed.turnStartRequests,
    conflictRefused: observed.conflictError !== null,
  };
  return problems.length === 0
    ? { status: "pass", reason: "duplicate deduplicated; conflict refused", evidence }
    : { status: "fail", reason: problems.join("; "), evidence };
}

export const duplicateReceiptRow = (context: ProviderContext) =>
  withThread(context, "duplicate-receipt", FULL_ACCESS, async (thread) => {
    const command = turnStartCommand({
      threadId: thread.threadId,
      provider: context.provider,
      model: context.model,
      text: prompt("duplicate", context.tokens.duplicate),
      ...FULL_ACCESS,
    });
    const first = await dispatch(context.rpc, command);
    const retryClient = await context.backend.connect();
    let retry: Record<string, unknown>;
    let conflictError: string | null = null;
    try {
      retry = await dispatch(retryClient, command);
      try {
        await dispatch(retryClient, {
          ...command,
          message: { ...command.message, text: "conflict" },
        });
      } catch (error) {
        conflictError = errorText(error);
      }
    } finally {
      retryClient.close();
    }
    const outcome = (await context.rpc.call("orchestration.getCommandOutcome", {
      commandId: command.commandId,
    })) as { status?: unknown; resultSequence?: unknown };
    const { view } = await waitForView(context.rpc, thread, context.timing, isSettled);
    // Give a wrongly duplicated second turn time to appear before counting.
    await delay(context.timing.pollMs * 4);
    const final = reduceThread(
      (await replayAll(context.rpc, thread.cursor)).events,
      thread.threadId,
    );
    return checkDuplicate({
      firstSequence: first.sequence,
      retrySequence: retry.sequence,
      outcomeStatus: outcome.status,
      outcomeSequence: outcome.resultSequence,
      conflictError,
      userMessageCount: userMessages(final.events, command.message.messageId),
      turnStartRequests: final.events.filter((e) => e.type === "thread.turn-start-requested")
        .length,
      settledCount: Math.max(view.settled.length, final.settled.length),
    });
  });
