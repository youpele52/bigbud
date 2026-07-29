import { describe, expect, it } from "vitest";

import {
  deriveDisplayedUserMessageState,
  extractLeadingDelegatedThreadProvenance,
} from "./terminalContext";

const provenanceBody = [
  "Parent thread: Parent task (thread-parent)",
  "Parent project: project-parent",
  "Delegation: delegation-1",
  "This is a delegated standalone thread. Complete the task below and report actionable results.",
].join("\n");

const provenanceBlock = [
  "<delegated_thread_provenance>",
  provenanceBody,
  "</delegated_thread_provenance>",
].join("\n");

describe("delegated thread provenance display state", () => {
  it("extracts a complete leading block and preserves the task and copy text exactly", () => {
    const task = "Keep this task visible exactly.\n\nIncluding its spacing.";
    const prompt = `${provenanceBlock}\n\n${task}`;

    expect(extractLeadingDelegatedThreadProvenance(prompt)).toEqual({
      promptText: task,
      provenance: { body: provenanceBody },
    });
    expect(deriveDisplayedUserMessageState(prompt)).toMatchObject({
      visibleText: task,
      copyText: prompt,
      delegatedThreadProvenance: { body: provenanceBody },
    });
  });

  it.each([
    ["a non-leading block", `Task first\n\n${provenanceBlock}`],
    ["leading whitespace", ` ${provenanceBlock}\n\nTask`],
    ["a missing closing tag", "<delegated_thread_provenance>\nParent thread: Parent\n\nTask"],
  ])("keeps %s visible", (_label, prompt) => {
    expect(extractLeadingDelegatedThreadProvenance(prompt)).toEqual({
      promptText: prompt,
      provenance: null,
    });
  });
});
