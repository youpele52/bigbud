import {
  THREAD_ORGANIZATION_STATES,
  THREAD_SNOOZE_MAX_MINUTES,
  THREAD_SNOOZE_MIN_MINUTES,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { Schema } from "effect";

const TARGET_THREAD_ID_PROPERTY = {
  type: "string",
  minLength: 1,
  description:
    "Optional canonical thread ID; omit for the current thread. Only explicitly requested current-project threads or directly delegated children are eligible.",
} as const;

export const MOVE_THREAD_TOOL_DESCRIPTION =
  "Move a bigbud thread to an Ìtútù state: present (active work), needs-you (waiting for the user), later (set aside), or done (finished). Organizing never starts, stops, archives, or answers anything. Omit targetThreadId for the current thread. When the requested task is actually complete, ask the user whether to move this thread to Done or Later, then call this only after they choose or if they already said which. Move another thread only when the current user explicitly requests it. Attached history alone does not authorize moving.";

export const SNOOZE_THREAD_TOOL_DESCRIPTION = `Snooze a bigbud thread: it moves to Later now and returns to Needs you after ${THREAD_SNOOZE_MIN_MINUTES} to ${THREAD_SNOOZE_MAX_MINUTES} minutes. A snooze is a reminder for the user; it does not pause work or schedule a message. Omit targetThreadId for the current thread. Snooze only when the current user asks for it.`;

export const MOVE_THREAD_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    state: {
      type: "string",
      enum: [...THREAD_ORGANIZATION_STATES],
      description: "Destination Ìtútù state",
    },
    targetThreadId: TARGET_THREAD_ID_PROPERTY,
  },
  required: ["state"],
  additionalProperties: false,
} as const;

export const SNOOZE_THREAD_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    minutes: {
      type: "integer",
      minimum: THREAD_SNOOZE_MIN_MINUTES,
      maximum: THREAD_SNOOZE_MAX_MINUTES,
      description: `Snooze duration in whole minutes (${THREAD_SNOOZE_MIN_MINUTES}–${THREAD_SNOOZE_MAX_MINUTES})`,
    },
    targetThreadId: TARGET_THREAD_ID_PROPERTY,
  },
  required: ["minutes"],
  additionalProperties: false,
} as const;

export const MoveThreadArguments = Schema.Struct({
  state: Schema.String,
  targetThreadId: Schema.optional(Schema.String),
});

export const SnoozeThreadArguments = Schema.Struct({
  minutes: Schema.Number,
  targetThreadId: Schema.optional(Schema.String),
});
