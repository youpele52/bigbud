import { createHash } from "node:crypto";
import type {
  RemoteAgentServiceLeaseBinding as Binding,
  RemoteAgentServiceLeaseController as Controller,
  RemoteAgentServiceLeaseStart as Start,
  RemoteAgentServiceLeaseResponse as Response,
} from "./remoteAgentProtocol.serviceLease.ts";
import { nativeLeaseLaunchFingerprint } from "./remoteAgentServiceLease.launch.ts";
export interface NativeLeaseBindingView {
  readonly authority: string;
  readonly installation: string;
  readonly nativeEpoch: string;
  readonly nonce: string;
  readonly publicationSha256: string;
  readonly executableSha256: string;
  readonly assetsSha256: string;
  readonly configurationSha256: string;
  readonly guardSha256: string;
}
export interface NativeLeaseEvidence {
  readonly binding: NativeLeaseBindingView;
  readonly generation: number;
  readonly originalChildPid: number;
  readonly originalController: Controller | undefined;
  readonly currentController: Controller | undefined;
  readonly previousController: Controller | undefined;
}
export interface NativeLeaseExitEvidence extends NativeLeaseEvidence {
  readonly kind: "native-exit";
}
export interface NativeLeaseCancellationEvidence {
  readonly kind: "native-cancel" | "never-invoked";
  readonly binding: NativeLeaseBindingView;
}
const digests = [
  "publicationSha256",
  "executableSha256",
  "assetsSha256",
  "configurationSha256",
  "guardSha256",
] as const;
export const copyBinding = (input: Binding): Binding => ({
  ...input,
  ...Object.fromEntries(digests.map((key) => [key, Uint8Array.from(input[key])])),
});
export const equalNativeLeaseBinding = (a: Binding | undefined, b: Binding) =>
  !!a &&
  a.authority === b.authority &&
  a.installation === b.installation &&
  a.nativeEpoch === b.nativeEpoch &&
  a.nonce === b.nonce &&
  digests.every((key) => Buffer.from(a[key]).equals(Buffer.from(b[key])));
export interface NativeLeaseRestore {
  readonly binding: Binding;
  readonly capability: Uint8Array;
  readonly assetsGeneration: string;
  readonly assetsReceiptSize: number;
  readonly assetsReceiptSha256: Uint8Array;
  readonly assetsArgument: string;
}
export function validateNativeLeaseReference(input: NativeLeaseRestore, epoch: string) {
  const b = input.binding;
  if (
    b.nativeEpoch !== epoch ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(b.nativeEpoch) ||
    !/^[a-f0-9]{32}$/.test(b.authority) ||
    !/^sha256:[a-f0-9]{64}$/.test(b.installation) ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(b.nonce) ||
    digests.some((key) => b[key].byteLength !== 32) ||
    input.capability.length < 32 ||
    input.capability.length > 64 ||
    !/^assets-[a-f0-9]{32}$/.test(input.assetsGeneration) ||
    !Number.isSafeInteger(input.assetsReceiptSize) ||
    input.assetsReceiptSize < 1 ||
    input.assetsReceiptSize > 8 * 1024 * 1024 ||
    input.assetsReceiptSha256.length !== 32 ||
    !/^--[a-z-]{1,62}$/.test(input.assetsArgument)
  )
    throw Error("Invalid original native lease reference.");
}
export function snapshotNativeLeaseReference(input: NativeLeaseRestore): NativeLeaseRestore {
  return {
    ...input,
    binding: copyBinding(input.binding),
    capability: Uint8Array.from(input.capability),
    assetsReceiptSha256: Uint8Array.from(input.assetsReceiptSha256),
  };
}
export function validateFreshNativeLease(input: Start, epoch: string, stateDir: string) {
  if (!input.binding) throw Error("Original native lease binding required.");
  validateNativeLeaseReference({ ...input, binding: input.binding }, epoch);
  if (
    input.guard.length < 1 ||
    input.guard.length > 16384 ||
    !Buffer.from(input.binding.guardSha256).equals(
      createHash("sha256").update(input.guard).digest(),
    ) ||
    !Buffer.from(input.binding.configurationSha256).equals(
      Buffer.from(nativeLeaseLaunchFingerprint(stateDir, input)),
    )
  )
    throw Error("Original native lease launch fingerprint mismatch.");
}
export function nativeLeaseBindingView(b: Binding): NativeLeaseBindingView {
  return Object.freeze({
    authority: b.authority,
    installation: b.installation,
    nativeEpoch: b.nativeEpoch,
    nonce: b.nonce,
    ...Object.fromEntries(digests.map((key) => [key, Buffer.from(b[key]).toString("hex")])),
  }) as NativeLeaseBindingView;
}
const controller = (value: Controller | undefined) =>
  value ? Object.freeze({ ...value }) : undefined;
export function nativeLeaseEvidence(value: Response): NativeLeaseEvidence {
  if (!value.binding) throw Error("Native evidence has no original binding.");
  return Object.freeze({
    binding: nativeLeaseBindingView(value.binding),
    generation: value.generation,
    originalChildPid: value.originalChildPid,
    originalController: controller(value.originalController),
    currentController: controller(value.currentController),
    previousController: controller(value.previousController),
  });
}
