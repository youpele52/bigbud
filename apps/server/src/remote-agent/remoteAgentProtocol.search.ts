/** Streaming workspace search frames (`search.proto`, capability `workspace.search-stream`). */
export const REMOTE_AGENT_SEARCH_STREAM_CAPABILITY = "workspace.search-stream";

/** `WorkspaceSearchMode` / `WorkspaceSearchPriority` wire values. */
export const REMOTE_AGENT_SEARCH_MODE = { names: 1, content: 2, both: 3 } as const;
export const REMOTE_AGENT_SEARCH_PRIORITY = { interactive: 1, background: 2 } as const;

export interface RemoteAgentWorkspaceSearchRoot {
  /** Opaque server label echoed in hits and per-root errors. */
  readonly rootId: string;
  readonly root: string;
  readonly relativePath: string;
}

export interface RemoteAgentWorkspaceSearchRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly roots: ReadonlyArray<RemoteAgentWorkspaceSearchRoot>;
  readonly query: string;
  readonly mode: (typeof REMOTE_AGENT_SEARCH_MODE)[keyof typeof REMOTE_AGENT_SEARCH_MODE];
  readonly maxResults: number;
  readonly maxResultsPerRoot: number;
  readonly deadlineMs: number;
  readonly maxThreads: number;
  readonly priority: (typeof REMOTE_AGENT_SEARCH_PRIORITY)[keyof typeof REMOTE_AGENT_SEARCH_PRIORITY];
}

export interface RemoteAgentWorkspaceSearchNameHit {
  readonly rootId: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly sizeBytes: number;
  readonly modifiedUnixMs: number;
  readonly score: number;
}

export interface RemoteAgentWorkspaceSearchContentHit {
  readonly rootId: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly excerpt: string;
}

export interface RemoteAgentWorkspaceSearchBatch {
  readonly requestId: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly names: ReadonlyArray<RemoteAgentWorkspaceSearchNameHit>;
  readonly contents: ReadonlyArray<RemoteAgentWorkspaceSearchContentHit>;
}

export interface RemoteAgentWorkspaceSearchCompleted {
  readonly requestId: string;
  readonly operationId: string;
  /** `complete`, `limit`, `deadline`, `cancelled` or `error`. */
  readonly stopReason: string;
  readonly truncated: boolean;
  readonly filesScanned: number;
  readonly rootErrors: ReadonlyArray<{ readonly rootId: string; readonly errorCode: string }>;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly batches: number;
}

export type RemoteAgentSearchFrame =
  | { readonly type: "workspaceSearchRequest"; readonly value: RemoteAgentWorkspaceSearchRequest }
  | { readonly type: "workspaceSearchBatch"; readonly value: RemoteAgentWorkspaceSearchBatch }
  | {
      readonly type: "workspaceSearchCompleted";
      readonly value: RemoteAgentWorkspaceSearchCompleted;
    };
