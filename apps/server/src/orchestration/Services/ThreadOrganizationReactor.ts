import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface ThreadOrganizationReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

/** Applies Ìtútù organization reactions to accepted domain events. */
export class ThreadOrganizationReactor extends ServiceMap.Service<
  ThreadOrganizationReactor,
  ThreadOrganizationReactorShape
>()("bigbud/orchestration/Services/ThreadOrganizationReactor") {}
