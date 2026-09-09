import type {
  ServerRestartRemoteAgentInput,
  ServerRestartRemoteAgentResult,
} from "@bigbud/contracts/server/server.remoteRestart.ts";
import { ServiceMap } from "effect";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

export interface RemoteAgentRestartServiceShape {
  readonly restart: (
    input: ServerRestartRemoteAgentInput,
  ) => Promise<ServerRestartRemoteAgentResult>;
  readonly status: (
    input: ServerRestartRemoteAgentInput,
  ) => Promise<ServerRestartRemoteAgentResult>;
}

export class RemoteAgentRestartService extends ServiceMap.Service<
  RemoteAgentRestartService,
  RemoteAgentRestartServiceShape
>()("bigbud/remote-agent/RemoteAgentRestart") {}

export interface RemoteAgentRestartRecord {
  readonly requestId: string;
  /** The request that owns the stop/start side effects when this is a joined alias. */
  readonly canonicalRequestId?: string;
  readonly projectId: string;
  readonly target: string;
  readonly runtime: RemoteAgentRuntime;
  readonly oldEpoch: string;
  readonly phase: ServerRestartRemoteAgentResult["phase"];
  readonly replacementEpoch?: string;
  readonly message: string;
  readonly revision?: number;
}

export interface RemoteAgentRestartStore {
  readonly get: (requestId: string) => Promise<RemoteAgentRestartRecord | undefined>;
  readonly put: (record: RemoteAgentRestartRecord) => Promise<void>;
  readonly update: (
    requestId: string,
    transition: (record: RemoteAgentRestartRecord) => RemoteAgentRestartRecord,
  ) => Promise<RemoteAgentRestartRecord>;
  readonly findActive?: (
    runtime: RemoteAgentRuntime,
    projectId: string,
  ) => Promise<RemoteAgentRestartRecord | undefined>;
}
