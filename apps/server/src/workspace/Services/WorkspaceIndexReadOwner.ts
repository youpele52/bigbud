import { ServiceMap } from "effect";

/** Optional owner for direct SSH workspace indexes. Failures must not trigger a legacy scan. */
export interface WorkspaceIndexReadOwnerShape {
  readonly indexWorkspace: (input: {
    readonly executionTargetId: string;
    readonly cwd: string;
  }) => Promise<{
    readonly entries: ReadonlyArray<{ readonly path: string; readonly directory: boolean }>;
    readonly truncated: boolean;
  }>;
}

export class WorkspaceIndexReadOwner extends ServiceMap.Service<
  WorkspaceIndexReadOwner,
  WorkspaceIndexReadOwnerShape
>()("t3/workspace/Services/WorkspaceIndexReadOwner") {}
