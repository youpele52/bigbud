import * as Schema from "effect/Schema";
import { MobileAssetsReceiptReference } from "../remote-backend/mobileGatewayAssets.receipt.reference.ts";

const Token = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Counter = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const MobileNativeGatewayBinding = Schema.Struct({
  authority: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  installation: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  nativeEpoch: Token,
  nonce: Token,
  publicationSha256: Digest,
  executableSha256: Digest,
  assetsSha256: Digest,
  configurationSha256: Digest,
  guardSha256: Digest,
});
export type MobileNativeGatewayBinding = typeof MobileNativeGatewayBinding.Type;
/** Original immutable execution identity. No capabilities, credentials or mutable P4 handoff here. */
export const MobileNativeGatewayOwnership = Schema.Struct({
  binding: MobileNativeGatewayBinding,
  assetsReference: MobileAssetsReceiptReference,
  assetsArgument: Schema.Literal("--assets-dir"),
});
export type MobileNativeGatewayOwnership = typeof MobileNativeGatewayOwnership.Type;
export const MobileNativeGatewayController = Schema.Struct({
  pid: Counter.check(Schema.isGreaterThanOrEqualTo(2)),
  boot: Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,64}$/)),
  started: Schema.String.check(Schema.isPattern(/^[0-9]{1,32}$/)),
});
export const MobileNativeGatewayCompletion = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("native-exit"),
    generation: Counter,
    originalChildPid: Counter,
    originalController: MobileNativeGatewayController,
    currentController: Schema.optional(MobileNativeGatewayController),
    previousController: Schema.optional(MobileNativeGatewayController),
  }),
  Schema.Struct({ kind: Schema.Literal("native-cancel") }),
  Schema.Struct({ kind: Schema.Literal("native-never-invoked") }),
]);
export type MobileNativeGatewayCompletion = typeof MobileNativeGatewayCompletion.Type;
