import { createHash } from "node:crypto";

/** Compare native agent instructions without exposing the prompt in provider snapshots. */
export function opencodeAgentSystemHash(system: string): string {
  return createHash("sha256").update(system.replace(/\r\n?/g, "\n").trim()).digest("hex");
}

/** OpenCode uses the Markdown body, excluding frontmatter, as the native agent system prompt. */
export function opencodeMarkdownAgentSystemHash(content: string): string | undefined {
  const body = content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "").trim();
  return body ? opencodeAgentSystemHash(body) : undefined;
}
