import { Schema } from "effect";

export const RENAME_THREAD_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "New canonical thread title",
    },
    targetThreadId: {
      type: "string",
      minLength: 1,
      description:
        "Optional canonical thread ID; omit for the current thread. Only explicitly requested current-project threads or directly delegated children are eligible.",
    },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

export const RenameThreadArguments = Schema.Struct({
  title: Schema.String,
  targetThreadId: Schema.optional(Schema.String),
});
