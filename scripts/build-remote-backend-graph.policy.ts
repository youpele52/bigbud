import { createHash } from "node:crypto";
import { isBackendGraphPath } from "../apps/server/src/remote-backend/backendGraph.manifest.ts";
import { BACKEND_GRAPH_LOADER_POLICY_DATA } from "./build-remote-backend-graph.policy.data.ts";

export type BackendGraphTarget = "aarch64-unknown-linux-gnu" | "x86_64-unknown-linux-gnu";
/** One reviewed non-literal loader or generated-code site. `member` is the bundle's
 * `//#region` source marker (package-relative) or an unbundled graph path; `sha256` pins the
 * whole region or file text, so any change to the reviewed code needs a new review. */
export interface ReviewedDynamicLoader {
  readonly member: string;
  readonly sha256: string;
  readonly reason: string;
  /** Graph files this loader can start or load (for example a spawned CLI entry). They are
   * validated as statically reachable roots and must live inside the graph's node_modules. */
  readonly roots: ReadonlyArray<string>;
}
export interface BackendGraphNativeAddon {
  readonly pkg: string;
  readonly target: BackendGraphTarget;
  readonly path: string;
}
export interface BackendGraphLoaderPolicy {
  readonly revision: 1;
  readonly createRequireShim: "import.meta.url-only";
  readonly reviewedDynamicLoaders: ReadonlyArray<ReviewedDynamicLoader>;
  /** Package specifiers (exact, `name/*` subpaths, or one `*` within a segment) that may be absent
   * from the graph only while every importing edge is lazy or statically unreachable. */
  readonly absentOptionalExternals: ReadonlyArray<string>;
  readonly nativeAddons: ReadonlyArray<BackendGraphNativeAddon>;
}

const targets = new Set(["aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]);
const digest = /^[a-f0-9]{64}$/;
function record(value: unknown, keys: ReadonlyArray<string>) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid backend graph loader policy object.");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key)))
    throw new Error("Backend graph loader policy has missing or unknown fields.");
  return object;
}
function list(value: unknown, maximum: number) {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error("Backend graph loader policy list is invalid or oversized.");
  return value as unknown[];
}
const text = (value: unknown, pattern: RegExp) => {
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error("Backend graph loader policy contains an invalid value.");
  return value;
};

export function decodeBackendGraphLoaderPolicy(value: unknown): BackendGraphLoaderPolicy {
  const policy = record(value, [
    "revision",
    "createRequireShim",
    "reviewedDynamicLoaders",
    "absentOptionalExternals",
    "nativeAddons",
  ]);
  if (policy.revision !== 1 || policy.createRequireShim !== "import.meta.url-only")
    throw new Error("Unsupported backend graph loader policy revision.");
  const reviewedDynamicLoaders = list(policy.reviewedDynamicLoaders, 256).map((value) => {
    const entry = record(value, ["member", "sha256", "reason", "roots"]);
    const roots = list(entry.roots, 16).map((root) => {
      if (!isBackendGraphPath(root) || !root.startsWith("node_modules/"))
        throw new Error("Reviewed loader roots must be graph node_modules members.");
      return root;
    });
    return Object.freeze({
      member: text(entry.member, /^[A-Za-z0-9@_.+/-]{1,512}$/),
      sha256: text(entry.sha256, digest),
      reason: text(entry.reason, /^[\x20-\x7e]{8,400}$/),
      roots: Object.freeze(roots),
    });
  });
  const absentOptionalExternals = list(policy.absentOptionalExternals, 64).map((value) =>
    text(value, /^(?:\.\.?\/)*[@A-Za-z0-9._*-]+(?:\/[A-Za-z0-9._*-]+)*$/),
  );
  const nativeAddons = list(policy.nativeAddons, 64).map((value) => {
    const entry = record(value, ["pkg", "target", "path"]);
    const pkg = text(entry.pkg, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/);
    const target = text(entry.target, /^[a-z0-9_-]+$/);
    if (
      !targets.has(target) ||
      !isBackendGraphPath(entry.path) ||
      !entry.path.startsWith(`node_modules/${pkg}/`) ||
      !entry.path.endsWith(".node")
    )
      throw new Error("Native addon entries must name a target and a .node file in its package.");
    return Object.freeze({ pkg, target: target as BackendGraphTarget, path: entry.path });
  });
  return Object.freeze({
    revision: 1,
    createRequireShim: "import.meta.url-only",
    reviewedDynamicLoaders: Object.freeze(reviewedDynamicLoaders),
    absentOptionalExternals: Object.freeze(absentOptionalExternals),
    nativeAddons: Object.freeze(nativeAddons),
  });
}

/** Hash recorded in build provenance (and so in the signed `buildDigest`). */
export function backendGraphLoaderPolicyDigest(policy: BackendGraphLoaderPolicy) {
  const canonical = decodeBackendGraphLoaderPolicy(policy);
  return createHash("sha256")
    .update(`bigbud.remote-backend.loader-policy.v1\0${JSON.stringify(canonical)}`)
    .digest("hex");
}

export function isAbsentOptionalExternal(policy: BackendGraphLoaderPolicy, specifier: string) {
  return policy.absentOptionalExternals.some((pattern) => {
    const source = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    return new RegExp(`^${source}(?:/.*)?$`).test(specifier);
  });
}

export const BACKEND_GRAPH_LOADER_POLICY: BackendGraphLoaderPolicy = decodeBackendGraphLoaderPolicy(
  BACKEND_GRAPH_LOADER_POLICY_DATA,
);
