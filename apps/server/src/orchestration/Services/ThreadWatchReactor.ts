import { Effect } from "effect";
import { ServiceMap } from "effect";
import type { Scope } from "effect";

export interface ThreadWatchReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ThreadWatchReactor extends ServiceMap.Service<
  ThreadWatchReactor,
  ThreadWatchReactorShape
>()("t3/orchestration/Services/ThreadWatchReactor/ThreadWatchReactor") {}
