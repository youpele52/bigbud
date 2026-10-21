import { createHash, randomBytes, sign } from "node:crypto";
import { Schema } from "effect";

export const V2_NATIVE_FAMILY_PROTOCOL = "bigbud.native-subagents.v1";
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Nonce = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
export const NativeFamilyRegistration = Schema.Struct({
  rootId: Id,
  storageIdentity: Id,
  threadId: Id,
  directory: Id,
  epoch: Schema.Int,
  transportGeneration: Id,
  nonce: Nonce,
  callbackToken: Hex,
  callbackUrl: Id,
  generation: Schema.Int,
  expires: Schema.Int,
});
export type NativeFamilyRegistration = typeof NativeFamilyRegistration.Type;
export const NativeFamilyCallback = Schema.Struct({
  protocol: Schema.Literal(V2_NATIVE_FAMILY_PROTOCOL),
  nonce: Nonce,
  rootId: Id,
  epoch: Schema.Int,
  transportGeneration: Id,
  generation: Schema.Int,
  sessionId: Id,
  requestNonce: Nonce,
  expires: Schema.Int,
  kind: Schema.Literals([
    "probe",
    "spawn",
    "enroll-child",
    "executor-settled",
    "permission",
    "context",
    "prompt",
  ]),
  payload: Schema.Record(Schema.String, Schema.Unknown),
});
export type NativeFamilyCallback = typeof NativeFamilyCallback.Type;
export type NativeFamilyMethod = "info" | "enroll" | "authorize" | "fence" | "inspect" | "receipt";
export const nativeFamilyHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function nativeFamilyEnvelope(
  privateKey: string,
  method: Exclude<NativeFamilyMethod, "info">,
  body: Record<string, unknown>,
) {
  const value = {
    protocol: V2_NATIVE_FAMILY_PROTOCOL,
    method,
    requestId: randomBytes(16).toString("hex"),
    expires: Date.now() + 10000,
    body,
  };
  return {
    ...value,
    signature: sign(
      null,
      Buffer.from(
        JSON.stringify([value.protocol, value.method, value.requestId, value.expires, value.body]),
      ),
      privateKey,
    ).toString("base64url"),
  };
}
export function nativeFamilyResponse(
  privateKey: string,
  request: NativeFamilyCallback,
  result: unknown,
) {
  const value = [
    V2_NATIVE_FAMILY_PROTOCOL,
    request.nonce,
    request.requestNonce,
    nativeFamilyHash(request),
    result,
  ];
  return {
    result,
    requestNonce: request.requestNonce,
    signature: sign(null, Buffer.from(JSON.stringify(value)), privateKey).toString("base64url"),
  };
}
