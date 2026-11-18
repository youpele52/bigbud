import {
  decodeMobileOwnerPairingInput,
  decodeMobileOwnerPairingResult,
  MOBILE_OWNER_PAIRING_MAX_BYTES,
  MOBILE_OWNER_PAIRING_PATH,
  type MobileOwnerPairingInput,
} from "../remote-backend/mobileOwnerPairing.protocol.ts";
import {
  sendOwnerSocketRequest,
  type OwnerSocketCredentials,
  type OwnerSocketOptions,
  withOwnerSocketCredentials,
} from "./cli.mobile.transport.ts";

const unavailable = () => new Error("Owner mobile pairing is unavailable.");
/** Private UDS-only transport. No redirects, retry, environment credential or caller-selected path. */
export async function sendMobileOwnerPairingRequest(
  input: MobileOwnerPairingInput,
  credentials: OwnerSocketCredentials,
  options: OwnerSocketOptions = {},
) {
  // One decoded snapshot: later caller mutation cannot change what is sent or validated.
  let snapshot: MobileOwnerPairingInput;
  try {
    snapshot = decodeMobileOwnerPairingInput(input);
  } catch {
    throw unavailable();
  }
  const response = await sendOwnerSocketRequest(
    {
      path: MOBILE_OWNER_PAIRING_PATH,
      body: JSON.stringify(snapshot),
      maxBytes: MOBILE_OWNER_PAIRING_MAX_BYTES,
    },
    credentials,
    unavailable,
    options,
  );
  try {
    if (response.status !== 200) throw unavailable();
    return decodeMobileOwnerPairingResult(JSON.parse(response.text), snapshot);
  } catch {
    throw unavailable();
  }
}

/** Remote account helper reads its own private config/token; no credential parameter reaches CLI. */
export async function createMobileOwnerPairing(value: unknown) {
  let input: MobileOwnerPairingInput;
  try {
    input = decodeMobileOwnerPairingInput(value);
  } catch {
    throw unavailable();
  }
  return withOwnerSocketCredentials(input.authorityId, 10_000, unavailable, (credentials, signal) =>
    sendMobileOwnerPairingRequest(input, credentials, { signal }),
  );
}
