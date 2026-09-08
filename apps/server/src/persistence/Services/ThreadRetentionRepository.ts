import * as ServiceMap from "effect/ServiceMap";

import type { ThreadRetentionRepositoryShape } from "./ThreadRetentionRepository.shape.ts";

export * from "./ThreadRetentionRepository.models.ts";
export type * from "./ThreadRetentionRepository.shape.ts";

export class ThreadRetentionRepository extends ServiceMap.Service<
  ThreadRetentionRepository,
  ThreadRetentionRepositoryShape
>()("t3/persistence/Services/ThreadRetentionRepository") {}
