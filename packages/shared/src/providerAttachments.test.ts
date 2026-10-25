import { expect, it } from "vitest";
import { providerAttachmentIssue, providerAttachmentPolicy } from "./providerAttachments";

it("allows attachments across all providers; target/model delivery is validated during preparation", () => {
  expect(providerAttachmentPolicy("opencodeV2").supported).toBe(true);
  expect(providerAttachmentIssue("opencodeV2", [{}])).toBeUndefined();
  expect(providerAttachmentIssue("opencodeV2", [])).toBeUndefined();
  expect(providerAttachmentIssue("opencodeV2", undefined)).toBeUndefined();
  for (const provider of [
    "opencode",
    "kilocode",
    "codex",
    "claudeAgent",
    "copilot",
    "pi",
    "cursor",
    "devin",
    "cliProxy",
  ])
    expect(providerAttachmentIssue(provider, [{}])).toBeUndefined();
});
