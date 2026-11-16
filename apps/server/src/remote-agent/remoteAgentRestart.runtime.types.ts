import type { RemoteAgentRestartDependencies } from "./remoteAgentRestart.dependencies.ts";
import type { RemoteAgentRestartRecord } from "./remoteAgentRestart.types.ts";

/** Account boot/restart uses runtime identity, never an invented project or project owner row. */
export interface RemoteAgentRuntimeRestartRequest {
  readonly requestId: string;
  readonly expectedWorkspaceExecutionTargetId: string;
}
export type RemoteAgentRuntimeRestartRecord = Omit<RemoteAgentRestartRecord, "projectId">;
export interface RemoteAgentRuntimeRestartStore {
  readonly get: (id: string) => Promise<RemoteAgentRuntimeRestartRecord | undefined>;
  readonly put: (record: RemoteAgentRuntimeRestartRecord) => Promise<void>;
  readonly update: (
    id: string,
    transition: (record: RemoteAgentRuntimeRestartRecord) => RemoteAgentRuntimeRestartRecord,
  ) => Promise<RemoteAgentRuntimeRestartRecord>;
}
export type RemoteAgentRuntimeRestartDependencies = Omit<
  RemoteAgentRestartDependencies,
  "store"
> & {
  readonly store: RemoteAgentRuntimeRestartStore;
  /** Account boot cannot turn a transient proxy failure into permission to stop a live supervisor. */
  readonly stopLiveSupervisor?: boolean;
};
