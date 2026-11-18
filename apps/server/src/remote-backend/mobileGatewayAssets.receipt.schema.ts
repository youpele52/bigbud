import * as Schema from "effect/Schema";
import {
  MobileRegistryOwnerSchema,
  MobileRegistryControllerSchema,
} from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import { MobileGatewayControllerHost } from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import {
  MOBILE_GATEWAY_RUNTIME_NAMESPACE,
  MobileAssetsReceiptGeneration,
  MobileAssetsReceiptSha256,
} from "./mobileGatewayAssets.receipt.reference.ts";
const Decimal = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]{0,19})$/));
export const MobileAssetsDirectoryAnchor = Schema.Struct({
  dev: Decimal,
  ino: Decimal,
  uid: Decimal,
  gid: Decimal,
  mode: Decimal,
});
export type MobileAssetsDirectoryAnchor = typeof MobileAssetsDirectoryAnchor.Type;
export const MobileAssetsEntryStat = Schema.Struct({
  ...MobileAssetsDirectoryAnchor.fields,
  nlink: Decimal,
  size: Decimal,
  mtimeNs: Decimal,
  ctimeNs: Decimal,
});
export type MobileAssetsEntryStat = typeof MobileAssetsEntryStat.Type;
export const MobileAssetsReceiptEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("directory"),
    pathDigest: MobileAssetsReceiptSha256,
    stat: MobileAssetsEntryStat,
  }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    pathDigest: MobileAssetsReceiptSha256,
    stat: MobileAssetsEntryStat,
    sha256: MobileAssetsReceiptSha256,
  }),
]);
export type MobileAssetsReceiptEntry = typeof MobileAssetsReceiptEntry.Type;
const Token = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,128}$/));
export const MobileAssetsReceipt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("mobile-native-assets"),
  namespace: Schema.Literal(MOBILE_GATEWAY_RUNTIME_NAMESPACE),
  generation: MobileAssetsReceiptGeneration,
  owner: MobileRegistryOwnerSchema,
  controller: MobileRegistryControllerSchema,
  controllerHost: MobileGatewayControllerHost,
  publication: Schema.Struct({
    stageId: Token,
    releaseId: Schema.String.check(Schema.isPattern(/^mobile-release:[a-f0-9]{64}$/)),
    consentRevision: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
    preparationNonce: Token,
    archiveSha256: MobileAssetsReceiptSha256,
  }),
  anchors: Schema.Struct({
    state: MobileAssetsDirectoryAnchor,
    namespace: MobileAssetsDirectoryAnchor,
    root: MobileAssetsDirectoryAnchor,
  }),
  contentBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  entries: Schema.Array(MobileAssetsReceiptEntry),
});
export type MobileAssetsReceipt = typeof MobileAssetsReceipt.Type;
