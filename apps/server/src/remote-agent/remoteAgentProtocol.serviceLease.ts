/** Private native owner transport only. Bootstrap/capability must never be logged. */
export interface RemoteAgentServiceLeaseBinding {
  readonly authority: string;
  readonly installation: string;
  readonly nativeEpoch: string;
  readonly nonce: string;
  readonly publicationSha256: Uint8Array;
  readonly executableSha256: Uint8Array;
  readonly assetsSha256: Uint8Array;
  readonly configurationSha256: Uint8Array;
  readonly guardSha256: Uint8Array;
}
export interface RemoteAgentServiceLeaseEnvironment {
  readonly name: string;
  readonly value: string;
}
export interface RemoteAgentServiceLeaseController {
  readonly pid: number;
  readonly boot: string;
  readonly started: string;
}
export interface RemoteAgentServiceLeaseQuery {
  readonly requestId: string;
  readonly binding: RemoteAgentServiceLeaseBinding | undefined;
  readonly capability: Uint8Array;
}
export interface RemoteAgentServiceLeaseStart extends RemoteAgentServiceLeaseQuery {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: ReadonlyArray<RemoteAgentServiceLeaseEnvironment>;
  readonly guard: Uint8Array;
  readonly assetsGeneration: string;
  readonly assetsReceiptSize: number;
  readonly assetsReceiptSha256: Uint8Array;
  readonly assetsArgument: string;
}
export interface RemoteAgentServiceLeaseControl extends RemoteAgentServiceLeaseQuery {
  readonly generation: number;
  readonly action: string;
}
export interface RemoteAgentServiceLeaseResponse {
  readonly requestId: string;
  readonly accepted: boolean;
  readonly state: string;
  readonly errorCode: string;
  readonly binding: RemoteAgentServiceLeaseBinding | undefined;
  readonly generation: number;
  readonly originalChildPid: number;
  readonly bootstrap: ReadonlyArray<RemoteAgentServiceLeaseEnvironment>;
  readonly originalController: RemoteAgentServiceLeaseController | undefined;
  readonly currentController: RemoteAgentServiceLeaseController | undefined;
  readonly previousController: RemoteAgentServiceLeaseController | undefined;
}
export type RemoteAgentServiceLeaseFrame =
  | { readonly type: "serviceLeaseStartRequest"; readonly value: RemoteAgentServiceLeaseStart }
  | { readonly type: "serviceLeaseStatusRequest"; readonly value: RemoteAgentServiceLeaseQuery }
  | { readonly type: "serviceLeaseResumeRequest"; readonly value: RemoteAgentServiceLeaseQuery }
  | { readonly type: "serviceLeaseControlRequest"; readonly value: RemoteAgentServiceLeaseControl }
  | {
      readonly type:
        | "serviceLeaseStartResponse"
        | "serviceLeaseStatusResponse"
        | "serviceLeaseResumeResponse"
        | "serviceLeaseControlResponse";
      readonly value: RemoteAgentServiceLeaseResponse;
    };
