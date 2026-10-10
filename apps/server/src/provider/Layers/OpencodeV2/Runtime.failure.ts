import type { SessionMessageAssistant } from "@opencode/client";

/** Only correlated terminal metadata and allowlisted classifications leave the native error boundary. */
export function v2NativeFailureMessage(message: SessionMessageAssistant | undefined): string {
  const error = message?.error;
  if (!message || !error) return "OpenCode v2 native execution failed.";
  const model = JSON.stringify(`${message.model.providerID}/${message.model.id}`).slice(0, 160);
  const status =
    error.status !== undefined &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
      ? ` (HTTP ${error.status})`
      : "";
  const prefix = `OpenCode v2 native model ${model}${status}`;
  if (
    message.model.providerID === "opencode" &&
    error.type === "provider.auth" &&
    error.status === 403 &&
    error.message === "OpenCode's free tier can only be used from within OpenCode"
  )
    return `${prefix} rejected this session's free-tier request context. Native TUI sessions may still work; this does not establish missing credentials. No automatic resend or model substitution.`;
  if (
    error.type === "provider.invalid-request" &&
    error.status === 410 &&
    error.message === `Model ${message.model.id} has been deprecated.`
  )
    return `${prefix} was reported deprecated by the upstream service. Select another model explicitly; no fallback was sent.`;
  if (
    error.type === "provider.invalid-request" &&
    error.status === 400 &&
    error.message === "Upstream request failed: Model is unavailable."
  )
    return `${prefix} is unavailable at the upstream service despite catalog availability. No automatic resend or fallback.`;
  if (error.type === "provider.auth")
    return `${prefix} was rejected by native provider authentication or access policy. Inspect that provider's native connection; no automatic resend or fallback.`;
  return `${prefix} execution failed. No automatic resend or fallback.`;
}
