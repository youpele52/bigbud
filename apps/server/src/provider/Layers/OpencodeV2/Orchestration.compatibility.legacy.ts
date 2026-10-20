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
