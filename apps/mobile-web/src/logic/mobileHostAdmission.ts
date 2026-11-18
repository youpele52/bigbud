import {
  REMOTE_BACKEND_MOBILE_RPC_REVISION,
  RemoteBackendMobileDescriptor,
} from "@bigbud/contracts/server/remoteBackendHandshake";
import {
  compareRemoteBackendMobileIdentity,
  supportsRemoteBackendMobileRevision,
  type RemoteBackendIdentityPin,
} from "@bigbud/shared/remoteBackendIdentity";
import * as Schema from "effect/Schema";

import { canonicalMobileHostOrigin } from "../lib/mobileHostSessions.logic";
import { readMobileResponseText } from "../lib/mobileHttpResponse";
import { createMobileIdentityRequest } from "./mobileHostAdmission.request";

export const MOBILE_HOST_REVISION_SUPPORT = {
  minimumMobileRpcRevision: REMOTE_BACKEND_MOBILE_RPC_REVISION,
  maximumMobileRpcRevision: REMOTE_BACKEND_MOBILE_RPC_REVISION,
} as const;

/** Public-safe, credential-free HTTPS read. A missing legacy endpoint never supplies an identity. */
export async function fetchMobileHostDescriptor(
  origin: string,
  options: { readonly signal?: AbortSignal; readonly fetch?: typeof fetch } = {},
): Promise<
  | { readonly status: "legacy" }
  | { readonly status: "descriptor"; readonly descriptor: RemoteBackendMobileDescriptor }
> {
  if (canonicalMobileHostOrigin(origin) !== origin) {
    throw new Error("Backend identity requires its exact HTTPS origin.");
  }
  const request = createMobileIdentityRequest(options.signal);
  let response: Response | undefined;
  try {
    request.signal.throwIfAborted();
    response = await request.wait(
      (options.fetch ?? fetch)(`${origin}/api/mobile/handshake`, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: request.signal,
      }).then((value) => {
        if (request.signal.aborted) void value.body?.cancel().catch(() => undefined);
        return value;
      }),
    );
    if (!response) throw new Error("Backend identity response is empty.");
    if (response.redirected || (response.url && new URL(response.url).origin !== origin)) {
      throw new Error("Backend identity cannot follow a redirect or change origin.");
    }
    if (response.status === 404) return { status: "legacy" };
    if (!response.ok)
      throw new Error("Could not verify this backend identity. Retry before pairing.");
    const text = await readMobileResponseText(response, request);
    try {
      return {
        status: "descriptor",
        descriptor: Schema.decodeUnknownSync(RemoteBackendMobileDescriptor)(JSON.parse(text)),
      };
    } catch {
      throw new Error("Backend identity response is invalid. Retry or update this host.");
    }
  } finally {
    request.dispose();
    // A peer's/custom stream's cancellation must never extend the request deadline.
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
}

/** This decision alone creates no pin, session or write permission. */
export function assessMobileHostDescriptor(
  descriptor: RemoteBackendMobileDescriptor,
  pin: RemoteBackendIdentityPin | null,
  confirmedFirstSeen: boolean,
): { readonly allowed: boolean; readonly reason: string } {
  if (!supportsRemoteBackendMobileRevision(descriptor, MOBILE_HOST_REVISION_SUPPORT)) {
    return { allowed: false, reason: "unsupported-revision" };
  }
  const verdict = compareRemoteBackendMobileIdentity(descriptor, pin, MOBILE_HOST_REVISION_SUPPORT);
  if (verdict !== "match" && verdict !== "first-seen") return { allowed: false, reason: verdict };
  if (!descriptor.mobileCapable) return { allowed: false, reason: "mobile-unavailable" };
  if (verdict === "first-seen" && !confirmedFirstSeen) {
    return { allowed: false, reason: "confirmation-required" };
  }
  return { allowed: true, reason: verdict };
}
