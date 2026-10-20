import type { SessionInfo } from "@opencode/client";
import { v2OwnerRegistration } from "./Orchestration.registration.ts";
import type { V2_THREAD_ACTIONS } from "./Orchestration.protocol.ts";
import type { OpencodeV2SharedBinding } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import type { decodeV2Cursor } from "./Runtime.cursor.ts";
import {
  V2_COMPACT_NATIVE_SESSION_PREFIX,
  isV2CompactNativeSessionId,
} from "./Orchestration.sessionIdentity.ts";

export type V2NativeRegistration = {
  readonly registrationFamily: "legacy" | "scoped";
  readonly profileIssuer?: string | undefined;
};

/** Durable creation material chooses the scheme; a cursor cannot silently downgrade or upgrade it. */
export function v2RetainedRegistrationFamily(
  row: OpencodeV2SharedBinding | undefined,
  cursor: ReturnType<typeof decodeV2Cursor> | undefined,
  profileIssuer: string | undefined,
) {
  const scoped = row?.identityKind === "shared-api-v2";
  if (
    row?.nativeSessionId.startsWith(V2_COMPACT_NATIVE_SESSION_PREFIX) &&
    (!scoped || !profileIssuer || !isV2CompactNativeSessionId(row.nativeSessionId, profileIssuer))
  )
    throw new Error(
      "V2 retained compact identity issuer/family conflicts; no replacement or replay.",
    );
  if (
    scoped
      ? row.profileIssuer !== profileIssuer || row.registrationFamily !== "scoped"
      : row?.profileIssuer !== undefined ||
        row?.registrationFamily === "scoped" ||
        cursor?.identityVersion === 2
  )
    throw new Error("V2 retained registration issuer/family conflicts; no replacement or replay.");
  if (
    cursor &&
    ((cursor.identityVersion !== undefined && cursor.identityVersion !== (scoped ? 2 : 1)) ||
      (cursor.profileIssuer !== undefined && cursor.profileIssuer !== row?.profileIssuer) ||
      (cursor.registrationFamily !== undefined &&
        cursor.registrationFamily !== (scoped ? "scoped" : "legacy")))
  )
    throw new Error("V2 retained cursor registration conflicts; no replacement or replay.");
  return scoped ? ("scoped" as const) : ("legacy" as const);
}

/** New native histories carry a full issuer and scheme; legacy histories are never relabelled. */
export function v2NativeRegistrationMetadata(identity: V2NativeRegistration) {
  if (identity.registrationFamily === "legacy") return {};
  if (!identity.profileIssuer || !/^[a-f0-9]{64}$/.test(identity.profileIssuer))
    throw new Error("V2 scoped native identity requires its profile issuer.");
  return {
    bigbud_issuer: identity.profileIssuer,
    bigbud_registration: "scoped",
    bigbud_identity: "shared-api-v2",
  };
}

export function matchesV2NativeRegistration(native: SessionInfo, identity: V2NativeRegistration) {
  const fields = native.metadata;
  if (identity.registrationFamily === "legacy")
    return (
      fields?.bigbud_issuer === undefined &&
      fields?.bigbud_registration === undefined &&
      fields?.bigbud_identity === undefined
    );
  return (
    fields?.bigbud_issuer === identity.profileIssuer &&
    fields?.bigbud_registration === "scoped" &&
    fields?.bigbud_identity === "shared-api-v2"
  );
}

/** Later native reads must retain the registration proven at initial acquisition. */
export function sameV2NativeRegistration(actual: SessionInfo, expected: SessionInfo) {
  return ["bigbud_issuer", "bigbud_registration", "bigbud_identity"].every(
    (field) => actual.metadata?.[field] === expected.metadata?.[field],
  );
}

export function v2NativeToolName(
  native: SessionInfo | undefined,
  action: (typeof V2_THREAD_ACTIONS)[number],
) {
  if (native?.metadata?.bigbud_registration !== "scoped") return `bigbud_thread_v1_${action}`;
  const issuer = native.metadata.bigbud_issuer;
  if (typeof issuer !== "string") throw new Error("V2 native registration issuer unavailable.");
  return v2OwnerRegistration({ issuer, bootstrapAbi: "bigbud.thread.bootstrap.v2" }).tool(action);
}
