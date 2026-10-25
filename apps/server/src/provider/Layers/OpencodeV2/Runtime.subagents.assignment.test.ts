import type { SessionMessageAssistant } from "@opencode/client";
import { expect, it } from "vitest";
import { PROVIDER_SUBAGENT_LIMITS } from "@bigbud/shared/providerSubagents";
import { v2SubagentAssignments } from "./Runtime.subagents.assignment.ts";

function launch(description: string, prompt: string): SessionMessageAssistant {
  return {
    id: "msg_launch",
    type: "assistant",
    agent: "build",
    model: { providerID: "synthetic-provider", id: "synthetic-model" },
    time: { created: 1 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [
      {
        type: "tool",
        id: "tool_launch",
        name: "subagent",
        time: { created: 1 },
        state: {
          status: "running",
          input: { description, prompt },
          metadata: { sessionID: "ses_child" },
        },
      },
    ],
  };
}

it("redacts URL credentials and bearer secrets from correlated assignment and prompt fields", () => {
  const text =
    "Review https://probe-user:probe-password@example.test/private Bearer probe-bearer-secret";
  const assignment = v2SubagentAssignments([launch(text, text)], new Set(["ses_child"])).get(
    "ses_child",
  )!;
  expect(assignment).toMatchObject({
    description: "Review [redacted-url] [redacted]",
    prompt: "Review [redacted-url] [redacted]",
  });
  for (const secret of ["probe-user", "probe-password", "probe-bearer-secret"])
    expect(JSON.stringify(assignment)).not.toContain(secret);
});

it("bounds oversized prompts and descriptions after redacting their secret-bearing prefix", () => {
  const text =
    "Bearer prefix-secret https://user:password@example.test/ " +
    "Investigate native observer ".repeat(2000);
  const assignment = v2SubagentAssignments([launch(text, text)], new Set(["ses_child"])).get(
    "ses_child",
  )!;
  expect(assignment.prompt?.length).toBe(PROVIDER_SUBAGENT_LIMITS.prompt);
  expect(assignment.description?.length).toBe(PROVIDER_SUBAGENT_LIMITS.progressSummary);
  expect(assignment.prompt?.endsWith("…")).toBe(true);
  expect(assignment.prompt).toContain("[redacted]");
  expect(assignment.prompt).toContain("[redacted-url]");
  expect(JSON.stringify(assignment)).not.toContain("prefix-secret");
  expect(JSON.stringify(assignment)).not.toContain("user:password");
});
