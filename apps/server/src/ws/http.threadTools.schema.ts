import { Data, Schema } from "effect";
import { AGENT_WORKSPACE_TOOL_NAMES } from "../orchestration-tools/AgentWorkspaceTools.ts";

export const ThreadToolRequest = Schema.Struct({
  action: Schema.Literals([
    "rename",
    "archive",
    "get_status",
    "list_pinned",
    "pin",
    "unpin",
    "computer_use",
    "browser",
    "create_thread",
    "send_thread_message",
    "list_threads",
    "search_capabilities",
    "read_capability_guide",
    "workspace",
    "remote_workspace_process",
  ]),
  threadId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  computerUseAction: Schema.optional(Schema.Unknown),
  browserAction: Schema.optional(Schema.Unknown),
  task: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  delivery: Schema.optional(Schema.Literals(["auto", "queue"])),
  projectId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["active", "archived", "all"])),
  limit: Schema.optional(Schema.Number),
  includeExcerpt: Schema.optional(Schema.Boolean),
  watchForCompletion: Schema.optional(Schema.Boolean),
  invocationId: Schema.optional(Schema.String),
  sourceMessageId: Schema.optional(Schema.String),
  workspacePath: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  capabilityId: Schema.optional(Schema.String),
  section: Schema.optional(
    Schema.Literals(["summary", "workflow", "permissions", "examples", "full"]),
  ),
  workspaceTool: Schema.optional(Schema.Literals(AGENT_WORKSPACE_TOOL_NAMES)),
  workspaceArguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  remoteCommand: Schema.optional(Schema.String),
  remoteArgs: Schema.optional(Schema.Array(Schema.String)),
  remoteStdin: Schema.optional(Schema.String),
  remoteAllowNonZeroExit: Schema.optional(Schema.Boolean),
  remoteTimeoutMs: Schema.optional(Schema.Number),
  remoteMaxOutputBytes: Schema.optional(Schema.Number),
  remoteOutputMode: Schema.optional(Schema.Literals(["error", "truncate"])),
});

export class ThreadToolRequestError extends Data.TaggedError("ThreadToolRequestError")<{
  readonly status: number;
  readonly message: string;
}> {}
