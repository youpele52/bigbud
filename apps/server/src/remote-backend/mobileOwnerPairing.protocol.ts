import * as Schema from "effect/Schema";
import { RemoteBackendAuthorityId } from "@bigbud/contracts/server/remoteBackendHandshake.ts";
import {
  MobileRemoteControlScope,
  ServerMobileRemotePairing,
} from "@bigbud/contracts/server/mobile";

export const MOBILE_OWNER_PAIRING_PATH = "/api/remote-backend/mobile/pairing";
export const MOBILE_OWNER_PAIRING_MAX_BYTES = 16 * 1024;
const Request = Schema.Struct({
  authorityId: RemoteBackendAuthorityId,
  scope: MobileRemoteControlScope,
  backendOrigin: Schema.String,
});
export type MobileOwnerPairingInput = typeof Request.Type;
export function decodeMobileOwnerPairingInput(value: unknown): MobileOwnerPairingInput {
  const input = Schema.decodeUnknownSync(Request)(value, { onExcessProperty: "error" });
  canonicalMobileOwnerOrigin(input.backendOrigin);
  return input;
}

export function canonicalMobileOwnerOrigin(value: string): string {
  const url = new URL(value);
  if (
    value.length > 2048 ||
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("A canonical HTTPS host origin is required.");
  return value;
}

/** Only the intentional one-time pairing link may leave the private CLI client. */
export function decodeMobileOwnerPairingResult(
  value: unknown,
  input: MobileOwnerPairingInput,
  now = Date.now(),
) {
  const result = Schema.decodeUnknownSync(ServerMobileRemotePairing)(value, {
    onExcessProperty: "error",
  });
  const expiry = Date.parse(result.expiresAt);
  const expiryText = result.expiresAt.includes(".")
    ? result.expiresAt
    : result.expiresAt.replace(/Z$/, ".000Z");
  const validExpiry =
    Number.isFinite(expiry) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result.expiresAt) &&
    new Date(expiry).toISOString() === expiryText;
  const url = new URL(result.pairUrl);
  const search = [...url.searchParams.entries()];
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (
    !validExpiry ||
    url.href !== result.pairUrl ||
    result.scope !== input.scope ||
    expiry <= now ||
    url.origin !== input.backendOrigin ||
    url.username ||
    url.password ||
    url.pathname !== `/mobile/pair/${encodeURIComponent(result.pairingId)}` ||
    search.length !== 1 ||
    search[0]?.[0] !== "backend" ||
    search[0]?.[1] !== input.backendOrigin ||
    [...fragment].length !== 1 ||
    fragment.get("secret") !== result.secret
  )
    throw new Error("Invalid owner pairing result.");
  return result;
}
