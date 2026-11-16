import { MobilePairingExchangeResponse } from "@bigbud/contracts/server/mobile";
import * as Schema from "effect/Schema";
import type { StoredMobileSession } from "./mobileSession";

/** Legacy credentials keep their original origin; serialized authority fields confer no trust. */
export function decodeStoredMobileSession(value: unknown): StoredMobileSession | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("backendBaseUrl" in value) ||
    typeof value.backendBaseUrl !== "string"
  )
    return null;
  try {
    const url = new URL(value.backendBaseUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    const session = Schema.decodeUnknownSync(MobilePairingExchangeResponse)(value);
    if (!Number.isFinite(Date.parse(session.expiresAt))) return null;
    return { ...session, backendBaseUrl: url.origin };
  } catch {
    return null;
  }
}
