import { randomUUID } from "node:crypto";
import * as Schema from "effect/Schema";
import {
  decodeMobileOwnerActivationRequest,
  MOBILE_CONSENT_CONFIRMATION,
  MOBILE_OWNER_ACTIVATION_MAX_BYTES,
  MOBILE_OWNER_ACTIVATION_PATH,
  MobileOwnerActivateResult,
  MobileOwnerConsentResult,
  MobileOwnerRefusal,
  MobileOwnerStatus,
  MobileOwnerStopResult,
  type MobileOwnerActivationRequest,
  type MobileOwnerRefusalCode,
} from "../remote-backend/mobileOwnerActivation.protocol.ts";
import {
  sendOwnerSocketRequest,
  withOwnerSocketCredentials,
  type OwnerSocketCredentials,
} from "./cli.mobile.transport.ts";

export type MobileOwnerReply<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly refused: MobileOwnerRefusalCode };
const unavailable = () => new Error("Owner mobile control is unavailable.");
const strict = { onExcessProperty: "error" } as const;

/** One request on already-read credentials; decodes only the fixed result or refusal shapes. */
export async function sendMobileOwnerRequest<S extends Schema.Decoder<unknown>>(
  input: MobileOwnerActivationRequest,
  result: S,
  credentials: OwnerSocketCredentials,
  options: { readonly signal?: AbortSignal; readonly deadlineMs?: number } = {},
): Promise<MobileOwnerReply<S["Type"]>> {
  let body: string;
  try {
    body = JSON.stringify(decodeMobileOwnerActivationRequest(input));
  } catch {
    throw unavailable();
  }
  const response = await sendOwnerSocketRequest(
    { path: MOBILE_OWNER_ACTIVATION_PATH, body, maxBytes: MOBILE_OWNER_ACTIVATION_MAX_BYTES },
    credentials,
    unavailable,
    options,
  );
  try {
    const json: unknown = JSON.parse(response.text);
    if (response.status === 200)
      return { ok: true, value: Schema.decodeUnknownSync(result)(json, strict) };
    return {
      ok: false,
      refused: Schema.decodeUnknownSync(MobileOwnerRefusal)(json, strict).refused,
    };
  } catch {
    throw unavailable();
  }
}

const deadlines = { status: 15_000, consent: 45_000, control: 120_000 } as const;
type Send = <S extends Schema.Decoder<unknown>>(
  input: MobileOwnerActivationRequest,
  result: S,
) => Promise<MobileOwnerReply<S["Type"]>>;
/** One owner session: credentials read once, every request under the same absolute deadline. */
const session = <A>(authorityId: string, deadlineMs: number, run: (send: Send) => Promise<A>) =>
  withOwnerSocketCredentials(authorityId, deadlineMs, unavailable, (credentials, signal) =>
    run((input, result) =>
      sendMobileOwnerRequest(input, result, credentials, { signal, deadlineMs }),
    ),
  );

export const readMobileOwnerStatus = (authorityId: string) =>
  session(authorityId, deadlines.status, (send) =>
    send({ action: "status", authorityId }, MobileOwnerStatus),
  );

/**
 * Durable consent grant (decision D-B). The caller must already hold the owner's explicit
 * confirmation; the CAS revision is the one this same session just observed in status.
 */
export const enableMobileOwnerConsent = (authorityId: string) =>
  session(authorityId, deadlines.consent, async (send) => {
    const status = await send({ action: "status", authorityId }, MobileOwnerStatus);
    if (!status.ok) return status;
    const revision = status.value.consent.revision;
    if (revision === null) return { ok: false as const, refused: "unavailable" as const };
    return send(
      {
        action: "consent-enable",
        authorityId,
        confirmation: MOBILE_CONSENT_CONFIRMATION,
        expectedRevision: revision,
      },
      MobileOwnerConsentResult,
    );
  });

export const activateMobileOwner = (
  authorityId: string,
  configuration: { readonly externalOrigin: string; readonly port: number },
) =>
  session(authorityId, deadlines.control, (send) =>
    send(
      { action: "activate", authorityId, requestId: randomUUID(), configuration },
      MobileOwnerActivateResult,
    ),
  );

export const stopMobileOwner = (authorityId: string) =>
  session(authorityId, deadlines.control, (send) =>
    send({ action: "stop", authorityId }, MobileOwnerStopResult),
  );
