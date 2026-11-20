import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

import { hasLocalSupervisorServiceControls } from "./localSupervisorService.paths.ts";

const HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
/** Each hop owns its authorization and HTTP connection framing. Cookies confer no relay authority. */
export function clientRelayHeaders(input: IncomingHttpHeaders): OutgoingHttpHeaders {
  const denied = new Set([...HOP, "authorization", "cookie", "set-cookie", "host"]);
  for (const name of String(input.connection ?? "").split(","))
    denied.add(name.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => !denied.has(key.toLowerCase()) && !key.toLowerCase().startsWith("access-control-"),
    ),
  );
}
export function clientRelayTarget(raw: string | undefined): string {
  if (
    !raw?.startsWith("/") ||
    raw.startsWith("//") ||
    hasLocalSupervisorServiceControls(raw) ||
    raw.includes(" ") ||
    raw.includes("\\")
  )
    throw new Error("Invalid relay request target.");
  const target = new URL(raw, "http://relay.invalid");
  target.searchParams.delete("token");
  return target.pathname + target.search;
}
