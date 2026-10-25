import type { Event } from "@opencode-ai/sdk/v2";

/** Resolve both current SDK envelopes and legacy nested session identities. */
export function opencodeEventSessionId(event: Event): string | undefined {
  if ("sessionID" in event.properties && typeof event.properties.sessionID === "string")
    return event.properties.sessionID;
  switch (event.type) {
    case "session.created":
    case "session.updated":
    case "session.deleted":
      return event.properties.info.id;
    case "message.updated":
      return event.properties.info.sessionID;
    case "message.part.updated":
      return event.properties.part.sessionID;
    default:
      return undefined;
  }
}
