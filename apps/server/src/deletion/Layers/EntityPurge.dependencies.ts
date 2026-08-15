import { Layer } from "effect";

import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { PurgeJobRepositoryLive } from "../../persistence/Layers/PurgeJobRepository.ts";

export const EntityPurgeDependenciesLive = Layer.merge(
  PurgeJobRepositoryLive,
  CheckpointStoreLive.pipe(Layer.provide(GitCoreLive)),
);
