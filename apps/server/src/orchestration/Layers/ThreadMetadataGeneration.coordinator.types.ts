import type { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { ServerSettings } from "@bigbud/contracts/core/settings.ts";
import type { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

import type { TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import type { PersistenceSqlError } from "../../persistence/Errors.ts";
import type {
  MetadataGenerationAttempt,
  MetadataGenerationJob,
  ThreadMetadataGenerationRepositoryShape,
} from "../../persistence/Services/ThreadMetadataGeneration.ts";
import type {
  MetadataCapturedContext,
  MetadataCapturedPath,
} from "./ThreadMetadataGeneration.context.ts";

export class MetadataCoordinatorError extends Data.TaggedError("MetadataCoordinatorError")<{
  readonly detail: string;
}> {}

export type MetadataCoordinatorFailure =
  | MetadataCoordinatorError
  | PersistenceSqlError
  | TextGenerationError;
type HostEffect<A> = Effect.Effect<A, MetadataCoordinatorFailure>;

/** Server-only integration boundaries. None of these capabilities come from model arguments. */
export interface MetadataCoordinatorHost {
  readonly now: () => string;
  readonly isCurrent: (context: MetadataCapturedContext) => HostEffect<boolean>;
  /** Capture this exact SQL-verified model with current transport/account identity; no generation. */
  readonly captureVerifiedThreadPath: (
    context: MetadataCapturedContext,
    selection: ModelSelection,
  ) => HostEffect<MetadataCapturedPath | null>;
  /** Must verify the captured account/configuration identity; never substitute another path. */
  readonly providerSettings: (
    context: MetadataCapturedContext,
    path: MetadataCapturedPath,
  ) => HostEffect<ServerSettings["providers"] | null>;
  /** Recheck workspace, configuration, source and ownership under their authoritative barriers. */
  readonly withDispatchAdmission: (
    context: MetadataCapturedContext,
    path: MetadataCapturedPath,
    claim: HostEffect<void>,
  ) => HostEffect<void>;
  /** Canonical event/projection/revision/job/attempt/receipt settlement in ONE transaction. */
  readonly commitResult: (
    job: MetadataGenerationJob,
    attempt: MetadataGenerationAttempt,
    context: MetadataCapturedContext,
  ) => HostEffect<void>;
}

export interface MetadataCoordinatorDependencies {
  readonly repository: ThreadMetadataGenerationRepositoryShape;
  readonly textGeneration: TextGenerationShape;
  readonly host: MetadataCoordinatorHost;
}
