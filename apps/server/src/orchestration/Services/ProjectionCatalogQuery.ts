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
import type { GetSidebarThreadCatalogResult } from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import { ServiceMap } from "effect";
import { Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type {
  OrchestrationLatestTurnState,
  OrchestrationThreadPurpose,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import type { ThreadWorkflowStatusLabel } from "../ThreadWorkflowStatus.logic.ts";

export interface ListCatalogThreadsInput {
  readonly callerThreadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly status: "active" | "archived" | "all";
  readonly limit: number;
  readonly includeExcerpt: boolean;
}

export interface CatalogThreadRow {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly workflowStatus: ThreadWorkflowStatusLabel;
  readonly isAgentActive: boolean;
  readonly isWorkflowComplete: boolean;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly deleting: boolean;
  readonly purpose: OrchestrationThreadPurpose;
  readonly parentThreadId: ThreadId | null;
  readonly latestTurnState: OrchestrationLatestTurnState | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastAssistantExcerpt?: string | null;
}

export interface ListCatalogThreadsResult {
  readonly callerResolved: boolean;
  readonly projectId: ProjectId | null;
  readonly projectTitle: string | null;
  readonly totalCount: number;
  readonly threads: ReadonlyArray<CatalogThreadRow>;
}

export class ProjectionThreadDetailNotFoundError extends Schema.TaggedErrorClass<ProjectionThreadDetailNotFoundError>()(
  "ProjectionThreadDetailNotFoundError",
  { threadId: Schema.String },
) {}

export type ProjectionCatalogQueryError =
  | ProjectionRepositoryError
  | ProjectionThreadDetailNotFoundError;

export interface ProjectionCatalogQueryShape {
  readonly listThreads: (
    input: ListCatalogThreadsInput,
  ) => Effect.Effect<ListCatalogThreadsResult, ProjectionRepositoryError>;
  readonly getSidebarThreadCatalog: () => Effect.Effect<
    GetSidebarThreadCatalogResult,
    ProjectionRepositoryError
  >;
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
