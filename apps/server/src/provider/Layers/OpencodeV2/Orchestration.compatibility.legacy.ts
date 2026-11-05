import { createHash } from "node:crypto";
import { V2_BOOTSTRAP_ABI } from "./Orchestration.plugin.specs.ts";
import { V2_IMPLEMENTATION_MANIFEST } from "./Orchestration.implementation.manifest.generated.ts";

/** Exact N0 descriptor encoding/order. Retaining it does not promote historical partial qualification. */
export const V2_N0_BOOTSTRAP_COMPATIBILITY = Object.freeze({
  format: "bigbud.thread.compatibility.v1",
  bootstrapAbi: V2_BOOTSTRAP_ABI,
  enrollmentProtocol: "bigbud.thread.enrollment.v2",
  callbackProtocol: "bigbud.thread.callback.v1",
  schemaDigest: V2_IMPLEMENTATION_MANIFEST.v1.schemaDigest,
  canonicalRequestAbi: "bigbud.thread.canonical.v1",
  resultEncoding: "bigbud.thread.final-json.v1",
  qualifiedVersions: Object.freeze(["2.0.26", "2.0.27"]),
});
export const V2_N0_COMPATIBILITY_DIGEST = createHash("sha256")
  .update(JSON.stringify(V2_N0_BOOTSTRAP_COMPATIBILITY))
  .digest("hex");

/** Original N1 descriptor: its signed modules still enforce >=2.0.26, even after policy changes. */
export const V2_N1_BOOTSTRAP_COMPATIBILITY = Object.freeze({
  format: "bigbud.thread.compatibility.v2",
  bootstrapAbi: V2_BOOTSTRAP_ABI,
  enrollmentProtocol: "bigbud.thread.enrollment.v2",
  callbackProtocol: "bigbud.thread.callback.v1",
  schemaDigest: V2_IMPLEMENTATION_MANIFEST.v1.schemaDigest,
  canonicalRequestAbi: "bigbud.thread.canonical.v1",
  resultEncoding: "bigbud.thread.final-json.v1",
  nativeContractDigest: "2b104fd6dc0ee985e2510e0b2d636ffd28caec33bde6dfc473cc6ce42aa9371e",
});
export const V2_N1_COMPATIBILITY_DIGEST = createHash("sha256")
  .update(JSON.stringify(V2_N1_BOOTSTRAP_COMPATIBILITY))
  .digest("hex");

/** Exact last single-issuer descriptor; neither new registration semantics nor qualification rewrite it. */
export const V2_N2_BOOTSTRAP_COMPATIBILITY = Object.freeze({
  format: "bigbud.thread.compatibility.v2",
  bootstrapAbi: "bigbud.thread.bootstrap.v1",
  enrollmentProtocol: "bigbud.thread.enrollment.v2",
  callbackProtocol: "bigbud.thread.callback.v1",
  schemaDigest: "614c41c704bc33dd72c7b0b0dde50bc0cd8e9d474a40542ae2ba3f411a49d853",
  canonicalRequestAbi: "bigbud.thread.canonical.v1",
  resultEncoding: "bigbud.thread.final-json.v1",
  nativeContractDigest: "c7553d8d07f5200ff0108e491d71050b2a679e877df468e12276b7be0db90473",
});
export const V2_N2_COMPATIBILITY_DIGEST =
  "778d3563d74e7eadf9a0169b4831b2555a50735c2eeabc82887010a683cce2b0";

/** Exact first scoped descriptor: its namespace recognizes only the historical hex IDs. */
export const V2_N3_BOOTSTRAP_COMPATIBILITY = Object.freeze({
  format: "bigbud.thread.compatibility.v2",
  bootstrapAbi: "bigbud.thread.bootstrap.v2",
  registration: "bigbud.thread.registration.issuer.v1",
  enrollmentProtocol: "bigbud.thread.enrollment.v2",
  callbackProtocol: "bigbud.thread.callback.v1",
  schemaDigest: "614c41c704bc33dd72c7b0b0dde50bc0cd8e9d474a40542ae2ba3f411a49d853",
  canonicalRequestAbi: "bigbud.thread.canonical.v1",
  resultEncoding: "bigbud.thread.final-json.v1",
  nativeContractDigest: "acb0dd8f603928dfcbb96b4098254b4364e2347c7014eb545f82bc674bef87e0",
});
export const V2_N3_COMPATIBILITY_DIGEST =
  "86b15341c40011159d02fa8a599d3655f6cbab717902c3c0cb219e78ba6d454c";

/** Exact compact-ID v3 descriptor from c015538b2ad999a1a76fb62186b8d8a3c540d9f8.
 * A new native API fingerprint does not rewrite retained signed modules or confer qualification. */
export const V2_N4_BOOTSTRAP_COMPATIBILITY = Object.freeze({
  format: "bigbud.thread.compatibility.v2",
  bootstrapAbi: "bigbud.thread.bootstrap.v3",
  registration: "bigbud.thread.registration.issuer.v1",
  enrollmentProtocol: "bigbud.thread.enrollment.v2",
  callbackProtocol: "bigbud.thread.callback.v1",
  schemaDigest: "614c41c704bc33dd72c7b0b0dde50bc0cd8e9d474a40542ae2ba3f411a49d853",
  canonicalRequestAbi: "bigbud.thread.canonical.v1",
  resultEncoding: "bigbud.thread.final-json.v1",
  nativeContractDigest: "7d05fb68bf15ebb2258ae3256a4aa3f5e12f4cdd69440661d7ccd4c1cf261ed0",
});
export const V2_N4_COMPATIBILITY_DIGEST =
  "d992b9c514082e59f91d877d954048e62a4a5025836b295097cdb64719d7b7db";

/** Exact three-action policy descriptor retained before the 2.2.5 consumed policy expansion. */
export const V2_N5_BOOTSTRAP_COMPATIBILITY = Object.freeze({
  format: "bigbud.thread.compatibility.v2",
  bootstrapAbi: "bigbud.thread.bootstrap.v3",
  registration: "bigbud.thread.registration.issuer.v1",
  enrollmentProtocol: "bigbud.thread.enrollment.v2",
  callbackProtocol: "bigbud.thread.callback.v1",
  schemaDigest: "614c41c704bc33dd72c7b0b0dde50bc0cd8e9d474a40542ae2ba3f411a49d853",
  canonicalRequestAbi: "bigbud.thread.canonical.v1",
  resultEncoding: "bigbud.thread.final-json.v1",
  nativeContractDigest: "7a2a95336e310d230d50982e48bfe26773cfa99dc05916b8fc295664f70cba88",
});
export const V2_N5_COMPATIBILITY_DIGEST =
  "769689fa33b2614d475fa5d61b0f6202bea9c27f489f6767d046a45071e81d73";

/** Exact last five-tool descriptor. HTML publication never rewrites retained signed evidence. */
export const V2_N6_BOOTSTRAP_COMPATIBILITY = Object.freeze({
  format: "bigbud.thread.compatibility.v2",
  bootstrapAbi: "bigbud.thread.bootstrap.v3",
  registration: "bigbud.thread.registration.issuer.v1",
  enrollmentProtocol: "bigbud.thread.enrollment.v2",
  callbackProtocol: "bigbud.thread.callback.v1",
  schemaDigest: "614c41c704bc33dd72c7b0b0dde50bc0cd8e9d474a40542ae2ba3f411a49d853",
  canonicalRequestAbi: "bigbud.thread.canonical.v1",
  resultEncoding: "bigbud.thread.final-json.v1",
  nativeContractDigest: "5c42274135e27b62dfbb7b7c98c51de81f2d116ff3b636ab4a7947b9fd546e7b",
});
export const V2_N6_COMPATIBILITY_DIGEST =
  "cbdafa7b78bad47c57546591aff8aa529beac9c802b5f1a66333529902d01a91";
