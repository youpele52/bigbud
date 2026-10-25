export type V2PureJson =
  | null
  | boolean
  | number
  | string
  | readonly V2PureJson[]
  | { readonly [key: string]: V2PureJson };
export type V2PureAction =
  | "create_thread"
  | "send_thread_message"
  | "get_thread_status"
  | "list_threads"
  | "rename_thread";
export type V2CanonicalAction =
  | "create_thread"
  | "send_thread_message"
  | "get_status"
  | "list_threads"
  | "rename";
export interface V2CanonicalBody {
  readonly action: V2CanonicalAction;
  readonly threadId?: string;
  readonly targetThreadId?: string;
  readonly title?: string;
  readonly task?: string;
  readonly message?: string;
  readonly delivery?: "auto" | "queue";
  readonly projectId?: string;
  readonly status?: "active" | "archived" | "all";
  readonly limit?: number;
  readonly includeExcerpt?: boolean;
  readonly watchForCompletion?: boolean;
}
export interface V2PureThreadHandler {
  readonly prepare: (value: {
    readonly action: V2PureAction;
    readonly input: Readonly<Record<string, V2PureJson>>;
    readonly callerThreadId: string;
  }) => V2CanonicalBody;
  readonly interpret: (value: {
    readonly action: V2PureAction;
    readonly canonicalResult: V2PureJson;
  }) => V2PureJson;
}
export interface V2ThreadImplementation extends V2PureThreadHandler {
  readonly implementationDigest: string;
  readonly bootstrapAbi: string;
  readonly schemaDigest: string;
  readonly canonicalRequestAbi: string;
  readonly resultEncoding: string;
}
