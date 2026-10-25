import type { OpencodeV2Client } from "./Client.ts";

export interface V2IsolatedProcessConfig {
  readonly sharedService?: undefined;
  readonly binaryPath: string;
  readonly profileRoot: string;
  readonly runtimeTargetId: string;
  readonly workspaceRoot?: string;
  readonly codingEndpoint?: { readonly url: string; readonly token: string };
}
export interface V2SharedProcessConfig {
  readonly sharedService: import("./SharedService.descriptor.ts").V2SharedConnection;
  readonly binaryPath?: never;
  readonly profileRoot?: never;
  readonly runtimeTargetId: string;
  readonly workspaceRoot?: never;
  readonly codingEndpoint?: never;
}
export type V2ProcessConfig = V2IsolatedProcessConfig | V2SharedProcessConfig;

export interface OwnedV2Process {
  readonly ownership?: "borrowed";
  readonly client: OpencodeV2Client;
  readonly isRunning: () => boolean;
  readonly hasExited?: () => boolean;
  readonly onDeath: (listener: () => void) => () => void;
  readonly onUnavailable?: (listener: () => void) => () => void;
  readonly close: () => Promise<void>;
}
