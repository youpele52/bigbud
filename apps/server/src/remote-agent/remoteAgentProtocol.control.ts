export interface RemoteAgentSupervisorShutdownRequest {
  readonly requestId: string;
  readonly expectedAgentEpoch: string;
  readonly expectedBuildDigest: string;
}

export interface RemoteAgentSupervisorShutdownResponse {
  readonly requestId: string;
  readonly accepted: boolean;
  readonly terminal: boolean;
  readonly detail: string;
}

export type RemoteAgentControlFrame =
  | {
      readonly type: "supervisorShutdownRequest";
      readonly value: RemoteAgentSupervisorShutdownRequest;
    }
  | {
      readonly type: "supervisorShutdownResponse";
      readonly value: RemoteAgentSupervisorShutdownResponse;
    };
