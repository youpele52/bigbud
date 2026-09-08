import { Data, Effect, Metric, Option, Queue, Semaphore } from "effect";

import {
  orchestrationCommandQueueDepth,
  orchestrationCommandQueueOverloadedTotal,
  startupCommandQueueDepth,
  startupCommandQueueOverloadedTotal,
} from "../observability/Metrics.ts";

export const ORCHESTRATION_COMMAND_QUEUE_CAPACITY = 256;
export const ORCHESTRATION_COMMAND_QUEUE_RESERVED_CAPACITY = 1;
export const STARTUP_COMMAND_QUEUE_CAPACITY = 128;
export const ORCHESTRATION_COMMAND_DEADLINE_MS = 30_000;
export const STARTUP_COMMAND_DEADLINE_MS = 15_000;
export const COMMAND_ADMISSION_RETRY_AFTER_MS = 250;

export type CommandAdmissionQueue = "orchestration" | "startup-readiness";

export class CommandAdmissionError extends Data.TaggedError("CommandAdmissionError")<{
  readonly code: "overloaded" | "deadline_exceeded";
  readonly queue: CommandAdmissionQueue;
  readonly message: string;
  readonly retryAfterMs: number;
}> {}

interface AdmissionMetrics {
  readonly depth: Metric.Metric<number, unknown>;
  readonly overloaded: Metric.Metric<number, unknown>;
}

const metricsFor = (queue: CommandAdmissionQueue): AdmissionMetrics =>
  queue === "orchestration"
    ? {
        depth: orchestrationCommandQueueDepth,
        overloaded: orchestrationCommandQueueOverloadedTotal,
      }
    : {
        depth: startupCommandQueueDepth,
        overloaded: startupCommandQueueOverloadedTotal,
      };

export interface BoundedCommandAdmission<A> {
  readonly queue: Queue.Queue<A>;
  readonly take: Effect.Effect<A>;
  readonly offer: (
    item: A,
    mode?: "external" | "internal",
  ) => Effect.Effect<void, CommandAdmissionError>;
}

export const makeBoundedCommandAdmission = <A>(input: {
  readonly capacity: number;
  readonly queue: CommandAdmissionQueue;
  readonly reservedCapacity?: number;
}): Effect.Effect<BoundedCommandAdmission<A>> =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<A>(input.capacity);
    const admissionSemaphore = yield* Semaphore.make(1);
    const metrics = metricsFor(input.queue);
    const externalCapacity = input.capacity - (input.reservedCapacity ?? 0);

    const updateDepth = (size: number) => Metric.update(metrics.depth, size);
    const overloaded = Effect.gen(function* () {
      yield* Metric.update(metrics.overloaded, 1);
      return yield* new CommandAdmissionError({
        code: "overloaded",
        queue: input.queue,
        message: `${input.queue} command admission queue is full; retry with the same command ID`,
        retryAfterMs: COMMAND_ADMISSION_RETRY_AFTER_MS,
      });
    });

    const offer = (item: A, mode: "external" | "internal" = "external") =>
      admissionSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const size = yield* Queue.size(queue);
          if (mode === "external" && size >= externalCapacity) {
            return yield* overloaded;
          }
          const offered = yield* Queue.offer(queue, item);
          if (!offered) {
            return yield* overloaded;
          }
          yield* updateDepth(size + 1);
        }),
      );

    const take = Effect.gen(function* () {
      const item = yield* Queue.take(queue);
      yield* updateDepth(yield* Queue.size(queue));
      return item;
    });

    return { queue, take, offer } satisfies BoundedCommandAdmission<A>;
  });

export const withCommandAdmissionDeadline = <A, E>(
  effect: Effect.Effect<A, E>,
  input: { readonly queue: CommandAdmissionQueue; readonly deadlineMs: number },
): Effect.Effect<A, E | CommandAdmissionError> =>
  effect.pipe(
    Effect.timeoutOption(input.deadlineMs),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new CommandAdmissionError({
              code: "deadline_exceeded",
              queue: input.queue,
              message: `${input.queue} command admission deadline exceeded; retry with the same command ID`,
              retryAfterMs: input.deadlineMs,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
