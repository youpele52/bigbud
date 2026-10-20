import { createHash } from "node:crypto";
import { V2_SHARED_REQUIRED_OPERATIONS } from "./SharedService.capabilities.ts";
import { V2_SHARED_REQUEST_FIELDS, V2_SHARED_RESPONSES } from "./SharedService.protocol.ts";

export const V2_CANONICAL_NATIVE_OPERATIONS = [
  ["get", "/api/config", "config.get"],
  ["get", "/api/plugin", "plugin.list"],
  ["get", "/api/debug/location", "debug.location.list"],
  ["get", "/api/shell", "shell.list"],
  ["post", "/api/rpc/{rpcID}/{method}", "rpc.call"],
] as const;

/** Stable consumed requirements, never observed whole-spec bytes or a tested-version list. */
const descriptor = {
  format: "bigbud.thread.native-contract.v1",
  clientRequestAbi: "@opencode/client@2.0.26",
  candidate: Object.freeze({ major: 2, syntax: "canonical-stable-numeric" }),
  platforms: ["darwin", "linux", "win32"],
  architectures: ["arm64", "x64"],
  discoveryOperations: V2_SHARED_REQUIRED_OPERATIONS,
  requests: V2_SHARED_REQUEST_FIELDS,
  responses: V2_SHARED_RESPONSES,
  canonicalOperations: V2_CANONICAL_NATIVE_OPERATIONS,
  canonicalProjections: {
    config: [
      "raw-array",
      "directory.path",
      "document.path?",
      "document.info.plugins?",
      "document.info.permissions?",
    ],
    plugin: [
      "location.directory",
      "data[].id?",
      "source:local|builtin|package|sdk",
      "local.path",
      "state:active|failed",
    ],
    loadedLocations: ["raw-array", "directory"],
    shell: ["location.directory", "data[].id", "status:running|exited|timeout|killed"],
    rpc: [
      "rpcID:path:string",
      "method:path:string",
      "location:optional:deepObject:explode",
      "input:unknown",
      "output:unknown",
      "installed-handshake:strict",
    ],
  },
  pluginSurface: Object.freeze([
    "app.version",
    "location.directory",
    "tool.list",
    "tool.transform",
    "session.get",
    "session.hook",
    "rpc.register",
    "registration.dispose",
  ]),
  semanticObligations: Object.freeze([
    "native-session-path-at-most-100-full-issuer-and-digest-256-bit-compact-v3",
    "permanent-compact-and-retained-hex-session-deny-boundaries",
    "ordered-native-catalog-deny",
    "context-generate-compaction-isolation",
    "rpc-cancellation-physical-lifetime",
    "immutable-executable-snapshot",
    "ordered-config-source-policy",
    "bounded-native-activity",
    "two-location-watcher-lifetime",
    "canonical-once-approval-receipts-history",
    "issuer-scoped-registrations-coexist-with-legacy",
    "profile-bound-native-history-and-tool-isolation",
    "permanent-issuer-session-deny-namespace-with-bounded-active-registry",
    "independent-publication-locks-and-atomic-shared-directory-creation",
  ]),
  bounds: Object.freeze({
    bodyBytes: 2097152,
    schemaNodes: 4096,
    referenceDepth: 32,
    locations: 64,
    shellsPerLocation: 1000,
    concurrency: 4,
    readMs: 5000,
    sweepMs: 10000,
  }),
};

/** Own a deep immutable copy without freezing/mutating the shared discovery validator's exports. */
function freezeDescriptor(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const item of Object.values(value)) freezeDescriptor(item);
  Object.freeze(value);
}
export const V2_NATIVE_CONTRACT = structuredClone(descriptor);
freezeDescriptor(V2_NATIVE_CONTRACT);
export const V2_NATIVE_CONTRACT_DIGEST = createHash("sha256")
  .update(JSON.stringify(V2_NATIVE_CONTRACT))
  .digest("hex");
