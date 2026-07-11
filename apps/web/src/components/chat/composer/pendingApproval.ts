import type { PendingApproval } from "../../../logic/session";

export function describePendingApproval(approval: PendingApproval): {
  summary: string;
  description: string;
} {
  if (approval.requestId.startsWith("learning-skill:")) {
    return {
      summary: "Skill improvement suggested",
      description:
        "bigbud has proposed a targeted patch to a provider-owned skill. The skill remains unchanged unless you approve it.",
    };
  }
  const suffix = approval.autoApproveAfterMs
    ? " It will auto-approve shortly because this thread is in full-access mode."
    : "";

  switch (approval.requestKind) {
    case "browser":
      return {
        summary: "Browser approval requested",
        description: `The agent wants to control a browser surface and requires your approval before continuing.${suffix}`,
      };
    case "command":
      return {
        summary: "Command approval requested",
        description: `The agent wants to run a command that requires your approval.${suffix}`,
      };
    case "file-read":
      return {
        summary: "File-read approval requested",
        description: `The agent wants to read a file or directory that requires your approval.${suffix}`,
      };
    case "file-change":
      return {
        summary: "File-change approval requested",
        description: `The agent wants to modify files and needs your approval before continuing.${suffix}`,
      };
    case "tool":
      return {
        summary: "Tool approval requested",
        description: `The agent wants to use a tool that requires your approval before continuing.${suffix}`,
      };
  }
}
