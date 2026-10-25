import { expect, it } from "vitest";
import { opencodeAgentSystemHash, opencodeMarkdownAgentSystemHash } from "./opencodeAgentSource.ts";

it("matches the native system prompt to the Markdown body without exposing instructions", () => {
  const hash = opencodeAgentSystemHash("Watch the task.\nReport blockers.");
  expect(
    opencodeMarkdownAgentSystemHash(
      "---\ndescription: Watches tasks\nmode: subagent\n---\n\nWatch the task.\nReport blockers.\n",
    ),
  ).toBe(hash);
  expect(hash).toMatch(/^[a-f0-9]{64}$/);
});

it("normalizes boundary whitespace and line endings but not differing instructions", () => {
  expect(
    opencodeMarkdownAgentSystemHash(
      "---\r\ndescription: Watches tasks\r\n---\r\n\r\nWatch.\r\nReport.\r\n",
    ),
  ).toBe(opencodeAgentSystemHash("Watch.\nReport."));
  expect(opencodeMarkdownAgentSystemHash("Different instructions.")).not.toBe(
    opencodeAgentSystemHash("Watch."),
  );
  expect(
    opencodeMarkdownAgentSystemHash("---\ndescription: No instructions\n---\n"),
  ).toBeUndefined();
});
