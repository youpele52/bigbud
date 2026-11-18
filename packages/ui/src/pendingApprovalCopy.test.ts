import { describe, expect, it } from "vitest";
import { describePendingApproval, type PendingApprovalCopyInput } from "./pendingApprovalCopy";

describe("pending approval presentation copy", () => {
  it.each([
    ["browser", "Browser approval requested", "control a browser surface"],
    ["command", "Command approval requested", "run a command"],
    ["file-read", "File-read approval requested", "read a file or directory"],
    ["file-change", "File-change approval requested", "modify files"],
    ["tool", "Tool approval requested", "use a tool"],
  ] as const)("preserves the %s explanation", (requestKind, summary, description) => {
    const copy = describePendingApproval({ requestId: "request", requestKind });
    expect(copy.summary).toBe(summary);
    expect(copy.description).toContain(description);
    expect(copy.description).not.toContain("auto-approve");
  });

  it("retains explicit approval for learning patches even with an auto-approval timeout", () => {
    expect(
      describePendingApproval({
        requestId: "learning-skill:one",
        requestKind: "file-change",
        autoApproveAfterMs: 5000,
      }),
    ).toEqual({
      summary: "Skill improvement suggested",
      description:
        "bigbud has proposed a targeted patch to a provider-owned skill. The skill remains unchanged unless you approve it.",
    });
  });

  it("retains the desktop full-access timeout guidance", () => {
    const approval: PendingApprovalCopyInput = {
      requestId: "one",
      requestKind: "command",
      autoApproveAfterMs: 5000,
    };
    expect(describePendingApproval(approval).description).toContain(
      "It will auto-approve shortly because this thread is in full-access mode.",
    );
  });
});
