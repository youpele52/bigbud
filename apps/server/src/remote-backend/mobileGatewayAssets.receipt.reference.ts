import * as Schema from "effect/Schema";
export const MOBILE_GATEWAY_RUNTIME_NAMESPACE = "remote-mobile-runtime-v1";
export const MOBILE_ASSETS_RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
export const MobileAssetsReceiptGeneration = Schema.String.check(
  Schema.isPattern(/^assets-[a-f0-9]{32}$/),
);
export const MobileAssetsReceiptSha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
/** Mechanical data only. Native verifies the original CAS binding, file and complete actual tree. */
export const MobileAssetsReceiptReference = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generation: MobileAssetsReceiptGeneration,
  sizeBytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(MOBILE_ASSETS_RECEIPT_MAX_BYTES),
  ),
  sha256: MobileAssetsReceiptSha256,
});
export type MobileAssetsReceiptReference = typeof MobileAssetsReceiptReference.Type;
