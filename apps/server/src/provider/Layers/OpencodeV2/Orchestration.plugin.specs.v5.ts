import { V2_HTML_BOOTSTRAP_SPECS } from "./Orchestration.plugin.specs.v4.ts";

/** ABI 5 adds an own-thread summary without rewriting retained public schemas. */
export const V2_SUMMARY_BOOTSTRAP_SPECS = [
  ...V2_HTML_BOOTSTRAP_SPECS,
  {
    name: "bigbud_thread_v1_set_elevator_summary",
    action: "set_elevator_summary",
    description:
      "Set the current thread's concise single-line elevator summary (up to 150 characters). No target thread is accepted.",
    input: {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: { type: "string", minLength: 1 } },
    },
  },
] as const;
