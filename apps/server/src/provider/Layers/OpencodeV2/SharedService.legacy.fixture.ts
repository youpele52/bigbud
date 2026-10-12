import type { PermissionRuleset } from "@opencode/client";

/** Frozen by executing immutable pre-API git sources, not current fingerprint/media/policy helpers.
 * Source: 79e2119689e2e0d4877ab74fc00f2fc11486e5be; Runtime.policy.shared.ts,
 * Runtime.policy.fingerprint.ts, Runtime.admission.ts, Admission.identity.ts, Runtime.media.content.ts.
 * Additional historical denies are intentional; synthetic paths contain no user configuration.
 */
export const legacyPolicy: PermissionRuleset = [
  { action: "*", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "question", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "read", resource: "/frozen/data/opencode", effect: "deny" },
  { action: "edit", resource: "/frozen/data/opencode", effect: "deny" },
  { action: "external_directory", resource: "/frozen/data/opencode", effect: "deny" },
  { action: "read", resource: "/frozen/data/opencode/*", effect: "deny" },
  { action: "edit", resource: "/frozen/data/opencode/*", effect: "deny" },
  { action: "external_directory", resource: "/frozen/data/opencode/*", effect: "deny" },
  { action: "read", resource: "/frozen/config/opencode", effect: "deny" },
  { action: "edit", resource: "/frozen/config/opencode", effect: "deny" },
  { action: "external_directory", resource: "/frozen/config/opencode", effect: "deny" },
  { action: "read", resource: "/frozen/config/opencode/*", effect: "deny" },
  { action: "edit", resource: "/frozen/config/opencode/*", effect: "deny" },
  { action: "external_directory", resource: "/frozen/config/opencode/*", effect: "deny" },
  { action: "read", resource: "/frozen/state/opencode", effect: "deny" },
  { action: "edit", resource: "/frozen/state/opencode", effect: "deny" },
  { action: "external_directory", resource: "/frozen/state/opencode", effect: "deny" },
  { action: "read", resource: "/frozen/state/opencode/*", effect: "deny" },
  { action: "edit", resource: "/frozen/state/opencode/*", effect: "deny" },
  { action: "external_directory", resource: "/frozen/state/opencode/*", effect: "deny" },
  { action: "edit", resource: "/frozen/extra-deny/**", effect: "deny" },
  { action: "shell", resource: "rm *", effect: "deny" },
];
export const legacyMaterials = {
  threadId: "frozen-pre-api-owner",
  requestMessageId: "frozen-request",
  nativeAdmissionId: "msg_bigbud_c6c05518e45693db1107203e6be75bb18659bd45eb950c23755feae9f5e49ff3",
  turnId: "opencode-v2-c6c05518e45693db1107203e6be75bb18659bd45eb950c23755feae9f5e49ff3",
  storageIdentity: "cd9a05d553638fa954aaec4c85fb27b7cf34471497c907daf0870136fceb4f0a",
  nativeSessionId: "ses_bigbud_2f4c32fbcace9ea40cbe19061bbdcb73488b0e8a2e1033def65d20703d64221d",
  fingerprint: "c88aa313ae5ad5b33550c0b62f6151d6252059e0b1084e97ba18cf2eeeb4b957",
  mediaDigest: "a581eeb3bf5f83240c9a1ffc9f1ff8b9de2d21f77947dfbb3ab837a9807d2650",
  originalBytesBase64: "b3JpZ2luYWwgbGVnYWN5IGJ5dGVz",
  attachment: {
    type: "file",
    id: "pre-api-context",
    name: "legacy.txt",
    mimeType: "text/plain",
    sizeBytes: 21,
  },
  preparedText:
    'Historical prompt\n\n<attachment_delivery>\nAttached paths refer to immutable snapshots on the provider execution target, not permission to read arbitrary host files. Prefer these paths with available reading tools, subject to existing approvals. Supplemental extracted/OCR text below is approximate and may be incomplete. Never bypass a denied read or silently assume missing visual information.\n[{"name":"legacy.txt","delivery":"supported content fallback; host path unavailable","sha256":"7889fbd09e975684914df4c6efdbb5c8219a7832bf6289acd5459532b78b933d"}]\n</attachment_delivery>\n\n<attached_file_contents>\n<file name="legacy.txt">\noriginal legacy bytes\n</file>\n</attached_file_contents>',
  executionPolicy: {
    version: 2,
    canonicalMode: "approval-required",
    nativePermissions: legacyPolicy,
  },
  learning: {
    nativeSessionId: "ses_bigbud_26c765ff0b568cd9c8d7eac902ee7ed5c3ea2c03b88f7a3f2069f832beec428e",
    ownerThreadId: "frozen-learning-owner",
    jobId: "frozen-learning-job",
    threadId: "learning-v2-9cd0573f4e65e3539407c20b5d5581fef3ac3173f1b5a0aab2fde079b7bceddd",
    requestMessageId:
      "learning-v2-9cd0573f4e65e3539407c20b5d5581fef3ac3173f1b5a0aab2fde079b7bceddd",
    nativeAdmissionId:
      "msg_bigbud_0b2b483e5a9baa7a2c33ca33d0ba0c06ec3648322623d7abcd860a0ca6404a03",
    turnId: "opencode-v2-0b2b483e5a9baa7a2c33ca33d0ba0c06ec3648322623d7abcd860a0ca6404a03",
  },
} as const;
