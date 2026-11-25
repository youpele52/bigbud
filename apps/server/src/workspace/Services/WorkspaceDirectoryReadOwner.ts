import { ServiceMap } from "effect";

/** Optional owner for direct SSH directory listing. Failures must not trigger a legacy read. */
export interface WorkspaceDirectoryReadOwnerShape {
  readonly listDirectory: (input: {
    readonly executionTargetId: string;
    readonly cwd: string;
    readonly relativeDir: string;
  }) => Promise<{
    readonly entries: ReadonlyArray<{ readonly name: string; readonly directory: boolean }>;
    readonly truncated: boolean;
  }>;
}

export class WorkspaceDirectoryReadOwner extends ServiceMap.Service<
  WorkspaceDirectoryReadOwner,
  WorkspaceDirectoryReadOwnerShape
>()("t3/workspace/Services/WorkspaceDirectoryReadOwner") {}
