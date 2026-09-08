/**
 * Aggregate workspace runtime façade.
 *
 * Callers should depend on the smallest capability (`files` or `search`) they
 * need. The façade exists to make backend selection a single composition
 * concern for server surfaces.
 */
import { ServiceMap } from "effect";

import type { WorkspaceFilesShape } from "./WorkspaceFiles.ts";
import type { WorkspaceSearchShape } from "./WorkspaceSearch.ts";
import type { WorkspaceWatchShape } from "./WorkspaceWatch.ts";

export interface WorkspaceRuntimeBackendShape {
  readonly files: WorkspaceFilesShape;
  readonly search: WorkspaceSearchShape;
  readonly watch: WorkspaceWatchShape;
}

export type WorkspaceRuntimeShape = WorkspaceRuntimeBackendShape;

export class WorkspaceRuntime extends ServiceMap.Service<WorkspaceRuntime, WorkspaceRuntimeShape>()(
  "bigbud/workspace-runtime/Services/WorkspaceRuntime",
) {}

export class RemoteWorkspaceRuntime extends ServiceMap.Service<
  RemoteWorkspaceRuntime,
  WorkspaceRuntimeBackendShape
>()("bigbud/workspace-runtime/Services/RemoteWorkspaceRuntime") {}
