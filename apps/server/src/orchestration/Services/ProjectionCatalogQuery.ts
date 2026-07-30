import type {
  GetProjectThreadSummariesInput,
  GetProjectThreadSummariesResult,
  GetStartupProjectCatalogInput,
  GetStartupProjectCatalogResult,
} from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import type {
  GetSelectedThreadDetailInput,
  GetSelectedThreadDetailResult,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import { ServiceMap } from "effect";
import { Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export class ProjectionThreadDetailNotFoundError extends Schema.TaggedErrorClass<ProjectionThreadDetailNotFoundError>()(
  "ProjectionThreadDetailNotFoundError",
  { threadId: Schema.String },
) {}

export type ProjectionCatalogQueryError =
  | ProjectionRepositoryError
  | ProjectionThreadDetailNotFoundError;

export interface ProjectionCatalogQueryShape {
  readonly getStartupProjectCatalog: (
    input: GetStartupProjectCatalogInput,
  ) => Effect.Effect<GetStartupProjectCatalogResult, ProjectionRepositoryError>;
  readonly getProjectThreadSummaries: (
    input: GetProjectThreadSummariesInput,
  ) => Effect.Effect<GetProjectThreadSummariesResult, ProjectionRepositoryError>;
  readonly getSelectedThreadDetail: (
    input: GetSelectedThreadDetailInput,
  ) => Effect.Effect<GetSelectedThreadDetailResult, ProjectionCatalogQueryError>;
}

export class ProjectionCatalogQuery extends ServiceMap.Service<
  ProjectionCatalogQuery,
  ProjectionCatalogQueryShape
>()("bigbud/orchestration/Services/ProjectionCatalogQuery") {}
