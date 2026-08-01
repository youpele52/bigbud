import { Data, Schema } from "effect";

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
});

export class ThreadToolRequestError extends Data.TaggedError("ThreadToolRequestError")<{
  readonly status: number;
  readonly message: string;
}> {}
