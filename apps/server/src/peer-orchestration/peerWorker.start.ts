/**
 * Worker-side child start (F-P8-3). The `peer_children` claim records a durable start intent;
 * this module completes it (`thread.create`, then the first `thread.turn.start`) outside the peer
 * request fiber, so a channel cut between the steps cannot lose the turn start. Every dispatch is
 * a pure function of the stored record, so a repeat is answered by the command receipts.
 *
 * - The delegate request waits for the start in a fiber owned by the starter's scope; an
 *   interrupted request leaves it running.
 * - `kick` (from status, follow and cancel) and the periodic sweep finish any start a crash or a
 *   transient failure left incomplete.
 * - A definite refusal settles the intent as failed with the reason; the child then reads failed.
 *
 * @module peerWorker.start
 */
import { CommandId, MessageId, ThreadId, type OrchestrationCommand } from "@bigbud/contracts";
import { DEFAULT_PROVIDER_INTERACTION_MODE } from "@bigbud/contracts/constants/runtime.constant.ts";
import { Duration, Effect, Fiber, Schedule, type Scope } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { stableThreadToolId } from "../orchestration-tools/ThreadOrchestrationTools.origins.ts";
import type {
  PeerChild,
  PeerChildRepositoryShape,
  PeerChildStart,
} from "../persistence/Services/PeerChildren.ts";

/** Reason recorded when a cancel arrives before the first turn was started. */
export const PEER_START_CANCELLED = "The child was cancelled before its first turn started.";
const SWEEP_INTERVAL = Duration.seconds(60);
const SWEEP_LIMIT = 100;
const KICK_MIN_INTERVAL_MS = 2_000;

type CreateCommand = Extract<OrchestrationCommand, { type: "thread.create" }>;
type TurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

/** The child's two start commands; identical for every attempt of one record. */
export function peerChildStartCommands(
  child: Pick<PeerChild, "commandId" | "childThreadId" | "createdAt">,
  start: PeerChildStart,
): readonly [CreateCommand, TurnStartCommand] {
  const threadId = ThreadId.makeUnsafe(child.childThreadId);
  const modelSelection = start.modelSelection as CreateCommand["modelSelection"];
  const common = {
    runtimeMode: start.runtimeMode as CreateCommand["runtimeMode"],
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: child.createdAt,
  } as const;
  return [
    {
      type: "thread.create",
      commandId: CommandId.makeUnsafe(child.commandId),
      threadId,
      projectId: start.projectId as CreateCommand["projectId"],
      title: start.title,
      purpose: "standard",
      modelSelection,
      branch: null,
      worktreePath: null,
      ...common,
    },
    {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(`${child.commandId}:turn`),
      threadId,
      message: {
        messageId: MessageId.makeUnsafe(stableThreadToolId("peer-message", child.commandId)),
        role: "user",
        text: start.task,
        attachments: [],
      },
      modelSelection,
      ...common,
    },
  ];
}

/** Refusals that will never change on a retry; anything else (storage, admission) is retried. */
function definiteRefusal(error: { readonly _tag?: string; readonly message?: string }) {
  switch (error._tag) {
    case "OrchestrationCommandIdConflictError":
      return "The dispatch identity conflicts with another command on the worker.";
    case "OrchestrationCommandInvariantError":
    case "OrchestrationCommandPreviouslyRejectedError":
      return `The worker refused to start the child: ${error.message ?? "invalid command"}`;
    default:
      return null;
  }
}

export interface PeerChildStarterDeps {
  readonly engine: OrchestrationEngineShape;
  readonly children: PeerChildRepositoryShape;
}

/** Completes one child's start intent; safe to repeat and to run after a crash. */
export const completePeerChildStart = Effect.fn("completePeerChildStart")(function* (
  deps: PeerChildStarterDeps,
  commandId: string,
) {
  const child = yield* deps.children.findByCommand(commandId);
  if (!child?.start || child.startCompletedAt !== null || child.startFailure !== null) return;
  const [create, turnStart] = peerChildStartCommands(child, child.start);
  const settleFailure = (failure: string) => deps.children.settleStart(commandId, { failure });
  const dispatch = (command: OrchestrationCommand) =>
    deps.engine.dispatch(command).pipe(
      Effect.as(true),
      Effect.catch((error) => {
        const failure = definiteRefusal(error as { _tag?: string; message?: string });
        return failure === null
          ? Effect.fail(error)
          : settleFailure(failure).pipe(Effect.as(false));
      }),
    );
  if (!(yield* dispatch(create))) return;
  // A cancel recorded before the turn starts means it never starts.
  if ((yield* deps.children.findByCommand(commandId))?.cancelRequestedAt)
    return yield* settleFailure(PEER_START_CANCELLED);
  if (!(yield* dispatch(turnStart))) return;
  yield* deps.children.settleStart(commandId, { completedAt: new Date().toISOString() });
  // A cancel that raced the turn start found nothing to interrupt; interrupt it now.
  const after = yield* deps.children.findByCommand(commandId);
  if (after?.cancelRequestedAt)
    yield* deps.engine
      .dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe(`${commandId}:cancel`),
        threadId: ThreadId.makeUnsafe(after.childThreadId),
        createdAt: after.cancelRequestedAt,
      })
      .pipe(Effect.ignore);
});

export interface PeerChildStarter {
  /** Runs the start in the starter's scope and waits for it; the request may go away. */
  readonly ensureStarted: (commandId: string) => Effect.Effect<void>;
  /** Starts an incomplete start in the background (rate limited per child). */
  readonly kick: (child: PeerChild) => Effect.Effect<void>;
}

export const makePeerChildStarter = Effect.fn("makePeerChildStarter")(function* (
  deps: PeerChildStarterDeps,
) {
  const scope: Scope.Scope = yield* Effect.scope;
  const running = new Map<string, { token: object; fiber: Fiber.Fiber<void, unknown> }>();
  const lastAttemptAt = new Map<string, number>();

  const run = (commandId: string) =>
    Effect.gen(function* () {
      const current = running.get(commandId);
      if (current) return current.fiber;
      lastAttemptAt.set(commandId, Date.now());
      const token = {};
      const fiber = yield* completePeerChildStart(deps, commandId).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("peer child start did not complete; it is retried", {
            commandId,
            cause,
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (running.get(commandId)?.token === token) running.delete(commandId);
          }),
        ),
        Effect.forkIn(scope),
      );
      running.set(commandId, { token, fiber });
      // A fiber that already finished ran its finalizer before it was recorded.
      if (fiber.pollUnsafe() !== undefined) running.delete(commandId);
      return fiber;
    });

  // Failures are logged by the fiber and retried by `kick` or the sweep; the status reports them.
  const ensureStarted: PeerChildStarter["ensureStarted"] = (commandId) =>
    run(commandId).pipe(Effect.flatMap(Fiber.await), Effect.asVoid);

  const kick: PeerChildStarter["kick"] = (child) =>
    Effect.suspend(() => {
      if (!child.start || child.startCompletedAt !== null || child.startFailure !== null)
        return Effect.void;
      const last = lastAttemptAt.get(child.commandId) ?? 0;
      if (running.has(child.commandId) || Date.now() - last < KICK_MIN_INTERVAL_MS)
        return Effect.void;
      return Effect.asVoid(run(child.commandId));
    });

  const sweep = deps.children.listIncompleteStarts(SWEEP_LIMIT).pipe(
    Effect.flatMap((children) => Effect.forEach(children, kick, { discard: true })),
    Effect.catchCause((cause) => Effect.logWarning("peer child start sweep failed", { cause })),
  );
  // At startup (a crash between the claim and the start) and then periodically.
  yield* sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.forkIn(scope));

  return { ensureStarted, kick } satisfies PeerChildStarter;
});
