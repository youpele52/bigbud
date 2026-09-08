const BROWSER_SYSTEM_PROMPT =
  "You have access to a Chromium browser in this environment. " +
  "Use it when the task requires live web interaction, navigation, UI verification, login flows, repros, scraping, or screenshots. " +
  "Prefer codebase inspection first when the task is local-only. " +
  "Summarize what was verified, including URL and important observations. " +
  "Avoid unnecessary browser use when terminal or file tools are sufficient.";

export function buildOpencodeSystemPrompt(remoteWorkspacePrompt?: string): string {
  return remoteWorkspacePrompt
    ? `${BROWSER_SYSTEM_PROMPT} ${remoteWorkspacePrompt}`
    : BROWSER_SYSTEM_PROMPT;
}
