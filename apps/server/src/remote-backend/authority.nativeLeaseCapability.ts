import { keyFingerprint } from "./authority.record.ts";
import { sign, createPublicKey, type KeyObject } from "node:crypto";

export const NATIVE_LEASE_CAPABILITY_DOMAIN = "bigbud.remote-backend.native-lease-capability.v1\0";

declare const derivationBrand: unique symbol;
export interface NativeLeaseCapabilityDerivation {
  (context: Uint8Array): Uint8Array;
  readonly [derivationBrand]: true;
}
const derivations = new WeakMap<object, string>();
/** Preserve original function identity; wrapping/binding must never upgrade a public signer. */
export function assertNativeLeaseCapabilityDerivation(
  value: unknown,
  expectedFingerprint: string,
): asserts value is NativeLeaseCapabilityDerivation {
  if (typeof value !== "function" || derivations.get(value) !== expectedFingerprint)
    throw Error("Original private native signer for the held identity required.");
}

/**
 * Internal loaded-identity helper only. It loads no key and grants no authority by itself.
 * Its caller must bind canonical context to the actual held identity/original native CAS.
 * Never route this method through the public challenge endpoint.
 */
export function makeNativeLeaseCapabilityDerivation(
  privateKey: KeyObject,
): NativeLeaseCapabilityDerivation {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519")
    throw Error("Native lease capability requires the loaded private Ed25519 identity.");
  const derive = Object.freeze((context: Uint8Array): Uint8Array => {
    if (!(context instanceof Uint8Array) || !context.byteLength || context.byteLength > 4096)
      throw Error("Invalid private native capability context size.");
    const owned = Uint8Array.from(context);
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(NATIVE_LEASE_CAPABILITY_DOMAIN), owned]),
      privateKey,
    );
    return Uint8Array.from(signature);
  }) as NativeLeaseCapabilityDerivation;
  derivations.set(derive, keyFingerprint(createPublicKey(privateKey)));
  return derive;
}
