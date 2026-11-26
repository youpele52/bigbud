/** Build A X2 terminal-host retirement verbs (protocol 1.10, `terminal.host-retirement`). */
export const TERMINAL_HOST_RETIREMENT_CAPABILITY = "terminal.host-retirement";
export const TERMINAL_HOST_MAX_PANES = 64;

export type TerminalHostPaneKind = "local" | "managed-ssh";

export interface TerminalHostPane {
  readonly ptyId: string;
  readonly threadId: string;
  readonly paneId: string;
  readonly kind: TerminalHostPaneKind;
  readonly ownerArtifactId: string;
  readonly leaseId: string;
  readonly canRetireSshSpawn: boolean;
}

export interface TerminalHostInventoryRequest {
  readonly requestId: string;
  readonly expectedEpoch: string;
  readonly maxPanes: number;
}

export interface TerminalHostInventoryResponse {
  readonly requestId: string;
  readonly agentEpoch: string;
  readonly agentVersion: string;
  readonly buildDigest: string;
  readonly ownerArtifactId: string;
  readonly panes: ReadonlyArray<TerminalHostPane>;
  readonly truncated: boolean;
  readonly sshSpawnRetirementAvailable: boolean;
  readonly accepted: boolean;
  readonly errorCode: string;
}

export interface TerminalHostRetireSshSpawnRequest {
  readonly requestId: string;
  readonly expectedEpoch: string;
  readonly expectedBuildDigest: string;
  readonly leaseIds: ReadonlyArray<string>;
}

export interface TerminalHostRetireSshSpawnResponse {
  readonly requestId: string;
  readonly agentEpoch: string;
  readonly accepted: boolean;
  readonly retiredLeaseIds: ReadonlyArray<string>;
  readonly sshSpawnRetired: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export type RemoteAgentTerminalHostFrame =
  | {
      readonly type: "terminalHostInventoryRequest";
      readonly value: TerminalHostInventoryRequest;
    }
  | {
      readonly type: "terminalHostInventoryResponse";
      readonly value: TerminalHostInventoryResponse;
    }
  | {
      readonly type: "terminalHostRetireSshSpawnRequest";
      readonly value: TerminalHostRetireSshSpawnRequest;
    }
  | {
      readonly type: "terminalHostRetireSshSpawnResponse";
      readonly value: TerminalHostRetireSshSpawnResponse;
    };
