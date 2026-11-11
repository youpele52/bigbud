import * as Schema from "effect/Schema";

export const SET_ELEVATOR_SUMMARY_TOOL_DESCRIPTION =
  "Set the current thread's elevator summary. Use a concise single-line description of its purpose or outcome (up to 150 characters). This only changes your own thread; no target thread is accepted.";
export const SET_ELEVATOR_SUMMARY_TOOL_PARAMETERS = {
  type: "object",
  properties: { summary: { type: "string", minLength: 1, description: "Concise thread summary" } },
  required: ["summary"],
  additionalProperties: false,
} as const;

export const SetElevatorSummaryArguments = Schema.Struct({ summary: Schema.String });
export const decodeSetElevatorSummaryArguments = (value: unknown) =>
  Schema.decodeUnknownSync(SetElevatorSummaryArguments)(value, { onExcessProperty: "error" });
