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
