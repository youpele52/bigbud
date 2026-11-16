import {
  allowsMobileCredentialOrigin,
  currentMobileDeploymentPolicy,
} from "../logic/mobileDeploymentPolicy";
import {
  MobilePairingStatus,
  MobilePairingExchangeResponse,
} from "@bigbud/contracts/server/mobile";
import * as Schema from "effect/Schema";

import { createMobileIdentityRequest } from "../logic/mobileHostAdmission.request";
import { readMobileResponseText } from "../lib/mobileHttpResponse";
import {
  MobilePairingHttpError,
  MOBILE_PAIRING_TIMEOUT_MESSAGE,
} from "../logic/mobileConnectionDiagnostics.logic";

export function normalizePairingBackendOrigin(raw: string | null, allowLegacyHttp: boolean) {
  try {
    const url = new URL(raw?.trim() ?? "");
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" && !(allowLegacyHttp && url.protocol === "http:"))
    )
      return "";
    return url.origin;
  } catch {
    return "";
  }
}

async function requestPairingJSON(
  origin: string,
  pairingId: string,
  exchange: { secret: string; label: string } | null,
  signal?: AbortSignal,
) {
  if (normalizePairingBackendOrigin(origin, true) !== origin) {
    throw new Error("Pairing requires an exact authorized backend origin.");
  }
  if (!allowsMobileCredentialOrigin(currentMobileDeploymentPolicy(), origin))
    throw new Error(
      "Open that host's own mobile app before pairing. Credentials stay on their own origin.",
    );
  const request = createMobileIdentityRequest(signal);
  let response: Response | undefined;
  try {
    request.signal.throwIfAborted();
    response = await request.wait(
      fetch(
        `${origin}/api/mobile/pairing/${encodeURIComponent(pairingId)}${exchange ? "/exchange" : ""}`,
        {
          method: exchange ? "POST" : "GET",
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          signal: request.signal,
          ...(exchange
            ? { headers: { "content-type": "application/json" }, body: JSON.stringify(exchange) }
            : {}),
        },
      ).then((value) => {
        if (request.signal.aborted) void value.body?.cancel().catch(() => undefined);
        return value;
      }),
    );
    if (
      !response ||
      response.redirected ||
      (response.url && new URL(response.url).origin !== origin)
    )
      throw new Error("Pairing cannot follow a redirect or change backend origin.");
    if (!response.ok)
      throw new MobilePairingHttpError(
        response.status,
        exchange ? "Pairing could not be completed." : "Pairing link is invalid or expired.",
      );
    const text = await readMobileResponseText(response, request);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("The backend returned an invalid pairing response.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("identity verification timed out"))
      throw new Error(MOBILE_PAIRING_TIMEOUT_MESSAGE, { cause: error });
    throw error;
  } finally {
    request.dispose();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
}

export async function readMobilePairingStatus(
  origin: string,
  pairingId: string,
  signal?: AbortSignal,
) {
  const raw = await requestPairingJSON(origin, pairingId, null, signal);
  try {
    return Schema.decodeUnknownSync(MobilePairingStatus)(raw);
  } catch {
    throw new Error("The backend returned an invalid pairing status.");
  }
}
export async function exchangeMobilePairing(
  origin: string,
  pairingId: string,
  input: { secret: string; label: string },
  signal?: AbortSignal,
) {
  const raw = await requestPairingJSON(origin, pairingId, input, signal);
  try {
    return Schema.decodeUnknownSync(MobilePairingExchangeResponse)(raw);
  } catch {
    throw new Error("The backend returned an invalid pairing authorization.");
  }
}
