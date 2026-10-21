import type {
  SessionMessageInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageIdle,
} from "@opencode/client";

/** Metadata-only reproduction of v2.0.32 shell notifications spanning two native busy periods. */
export function backgroundAssistant(id: string, shellIds: string[] = []): SessionMessageAssistant {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "synthetic-provider", id: "synthetic-model" },
    time: { created: 3, completed: 4 },
    finish: shellIds.length ? "tool-calls" : "stop",
    content: [
      { type: "text", text: `output ${id}` },
      ...shellIds.map(
        (shellID): SessionMessageAssistantTool => ({
          type: "tool" as const,
          id: `call_${shellID}`,
          name: "shell",
          time: { created: 3, completed: 4 },
          state: {
            status: "completed" as const,
            input: {},
            content: [{ type: "text", text: "Background command started." }],
            metadata: { status: "running", shellID },
          },
        }),
      ),
    ],
  };
}

export function backgroundNotice(shellID: string): SessionMessageInfo {
  return {
    id: `notice_${shellID}`,
    type: "synthetic",
    time: { created: 5 },
    text: "completion",
    metadata: { source: "shell", shellID, jobID: shellID, state: "completed" },
  };
}

export function backgroundIdle(
  id: string,
  outcome: SessionMessageIdle["outcome"],
): SessionMessageIdle {
  return { id, type: "idle", time: { created: 6 }, outcome };
}

export function backgroundInterval(): SessionMessageInfo[] {
  return [
    backgroundAssistant("launch", ["sh_first", "sh_late"]),
    backgroundNotice("sh_first"),
    backgroundAssistant("before-interruption"),
    backgroundIdle("interrupted", "interrupted"),
  ];
}

export function backgroundContinuation(): SessionMessageInfo[] {
  return [
    backgroundNotice("sh_late"),
    backgroundAssistant("after-interruption"),
    backgroundIdle("final", "succeeded"),
  ];
}
