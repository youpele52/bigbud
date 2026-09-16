const SENSITIVE_QUERY_KEYS =
  /([?&](?:token|key|secret|password|authorization|credential)=)[^&#\s]*/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const WEBSOCKET_URL = /wss?:\/\/[^\s)]+/gi;

export function redactMobileText(value: string): string {
  return value
    .replace(SENSITIVE_QUERY_KEYS, "$1[redacted]")
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(WEBSOCKET_URL, "[websocket address redacted]");
}
