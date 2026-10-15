import {
  v2ConfigSourcePaths,
  type V2ConfigSourcePlatform,
} from "./NativeCompatibility.sources.platform.ts";
import type { OpencodeV2Client } from "./Client.ts";
import {
  V2NativeCompatibilityError,
  type V2NativeSemanticProfile,
} from "./NativeCompatibility.types.ts";

/** Select a finite observed source contract, never infer source semantics from a version.
 * With no machine markers, the legacy/common shape is explicit even on future versions. */
export function selectV2NativeConfigProfile(
  entries: Awaited<ReturnType<OpencodeV2Client["config"]["get"]>>,
  root: string,
  platform?: V2ConfigSourcePlatform,
): V2NativeSemanticProfile {
  const { systemRoot, machineDocument, same } = v2ConfigSourcePaths(platform);
  if (!Array.isArray(entries) || entries.length > 256)
    validateV2NativeConfigSources(entries, root, "v2-global-config-v1", platform);
  const machine =
    Array.isArray(entries) &&
    entries.some(
      (entry) =>
        entry &&
        ((entry.type === "directory" &&
          typeof entry.path === "string" &&
          same(entry.path, systemRoot)) ||
          (entry.type === "document" &&
            typeof entry.path === "string" &&
            machineDocument(entry.path))),
    );
  const profile = machine ? "v2-system-global-config-v1" : "v2-global-config-v1";
  validateV2NativeConfigSources(entries, root, profile, platform);
  return profile;
}

/** Observed source order only; machine/MDM policy is a bounded native projection, never a raw host read. */
export function validateV2NativeConfigSources(
  entries: Awaited<ReturnType<OpencodeV2Client["config"]["get"]>>,
  root: string,
  profile: V2NativeSemanticProfile,
  platform?: V2ConfigSourcePlatform,
) {
  const { canonical, systemRoot, machineDocument, protectedPath, paths, key, same } =
    v2ConfigSourcePaths(platform);
  const fail = () => {
    throw new V2NativeCompatibilityError(
      "config-source-unverified",
      "native configuration source ordering/policy could not be verified; no machine files or installation target were changed.",
    );
  };
  if (
    !canonical(root) ||
    paths.dirname(root) === root ||
    protectedPath(root) ||
    !Array.isArray(entries) ||
    !entries.length ||
    entries.length > 256 ||
    Buffer.byteLength(JSON.stringify(entries)) > 2097152
  )
    fail();
  const machinePaths = new Set<string>(),
    directoryPaths = new Set<string>();
  let globalSeen = false,
    systemSeen = false;
  for (const entry of entries) {
    if (!entry || !["directory", "document"].includes(entry.type)) fail();
    if (entry.type === "directory") {
      if (!canonical(entry.path) || directoryPaths.has(key(entry.path))) fail();
      directoryPaths.add(key(entry.path));
      if (!globalSeen) {
        if (
          profile === "v2-system-global-config-v1" &&
          !systemSeen &&
          directoryPaths.size === 1 &&
          same(entry.path, systemRoot)
        ) {
          systemSeen = true;
          continue;
        }
        if (!same(entry.path, root)) fail();
        globalSeen = true;
      } else if (protectedPath(entry.path)) fail();
      continue;
    }
    if (entry.path !== undefined && !canonical(entry.path)) fail();
    if (!entry.info || typeof entry.info !== "object" || Array.isArray(entry.info)) fail();
    const info = entry.info as unknown as Record<string, unknown>;
    if (info.permission !== undefined || info.plugin !== undefined) fail();
    if (info.plugins !== undefined && (!Array.isArray(info.plugins) || info.plugins.length > 1000))
      fail();
    if (info.permissions !== undefined) {
      if (!Array.isArray(info.permissions) || info.permissions.length > 1000) fail();
      for (const rule of info.permissions as unknown[]) {
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) fail();
        const r = rule as Record<string, unknown>;
        if (
          ![r.action, r.resource].every(
            (v) => typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= 4096,
          ) ||
          !["allow", "ask", "deny"].includes(r.effect as string) ||
          Object.keys(r).some((key) => !["action", "resource", "effect"].includes(key))
        )
          fail();
      }
    }
    const machine = entry.path !== undefined && machineDocument(entry.path);
    if (machine) {
      if (
        profile !== "v2-system-global-config-v1" ||
        globalSeen ||
        [...machinePaths].some((value) => same(value, entry.path!))
      )
        fail();
      machinePaths.add(entry.path!);
    } else {
      // Native discovery emits a global config document before its directory marker.
      // Only these exact files may precede it; the marker still proves the install root.
      const globalDocument =
        typeof entry.path === "string" &&
        (same(entry.path, paths.join(root, "opencode.json")) ||
          same(entry.path, paths.join(root, "opencode.jsonc")));
      if (
        (!globalSeen && !globalDocument) ||
        (entry.path !== undefined && protectedPath(entry.path))
      )
        fail();
    }
  }
  if (!globalSeen) fail();
  return machinePaths;
}

/** Drop unconsumed account/provider fields before carrying native policy into installer inspection. */
export function projectV2NativeConfigSources(
  entries: Awaited<ReturnType<OpencodeV2Client["config"]["get"]>>,
) {
  return entries.map((entry) =>
    entry.type === "directory"
      ? { type: entry.type, path: entry.path }
      : {
          type: entry.type,
          ...(entry.path ? { path: entry.path } : {}),
          info: {
            ...(entry.info.plugins ? { plugins: entry.info.plugins } : {}),
            ...(entry.info.permissions ? { permissions: entry.info.permissions } : {}),
          },
        },
  );
}
