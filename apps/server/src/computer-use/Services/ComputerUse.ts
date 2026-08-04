import type { ComputerUseAction, ComputerUseResult, ThreadId } from "@bigbud/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

export class ComputerUseError extends Data.TaggedError("ComputerUseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ComputerUseShape {
  readonly isActive?: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly withThreadLease?: <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ComputerUseError, R>;
  readonly execute: (
    threadId: ThreadId,
    action: ComputerUseAction,
  ) => Effect.Effect<ComputerUseResult, ComputerUseError>;
  readonly dispose: Effect.Effect<void, never>;
}

export class ComputerUse extends ServiceMap.Service<ComputerUse, ComputerUseShape>()(
  "t3/computer-use/Services/ComputerUse",
) {}
