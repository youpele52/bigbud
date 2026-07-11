import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface LearningReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class LearningReactor extends ServiceMap.Service<LearningReactor, LearningReactorShape>()(
  "t3/orchestration/Services/LearningReactor",
) {}
