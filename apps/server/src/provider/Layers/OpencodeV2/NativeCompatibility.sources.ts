import {
  v2ConfigSourcePaths,
  type V2ConfigSourcePlatform,
} from "./NativeCompatibility.sources.platform.ts";
import type { OpencodeV2Client } from "./Client.ts";
import {
  V2NativeCompatibilityError,
  type V2NativeSemanticProfile,
} from "./NativeCompatibility.types.ts";
import { V2DiagnosticError, type V2DiagnosticCode } from "./PluginSetup.diagnostics.ts";
import { validateV2ConfigControls } from "./NativeCompatibility.sources.controls.ts";

type Entries = Awaited<ReturnType<OpencodeV2Client["config"]["get"]>>;

/** Profile selection is structural, never a claim about virtual-document origin or native qualification. */
export function selectV2NativeConfigProfile(
  entries: Entries,
  root: string,
  platform?: V2ConfigSourcePlatform,
): V2NativeSemanticProfile {
  const { systemRoot, machineDocument, same } = v2ConfigSourcePaths(platform);
  const machine =
    Array.isArray(entries) &&
    entries.length <= 256 &&
    entries.some(
      (entry) =>
        entry &&
        typeof entry.path === "string" &&
        ((entry.type === "directory" && same(entry.path, systemRoot)) ||
          (entry.type === "document" && machineDocument(entry.path))),
    );
  const profile = machine ? "v2-system-global-config-v1" : "v2-global-config-v1";
  validateV2NativeConfigSources(entries, root, profile, platform);
  return profile;
}

/** Observable native grammar (2.1.4/2.2.0): early machine policies, unattributed virtuals,
 * global files + marker, project/content layers, then machine files + discovery marker.
 * Only the exact global marker proves the installation root. No machine or virtual writes. */
export function validateV2NativeConfigSources(
  entries: Entries,
  root: string,
  profile: V2NativeSemanticProfile,
  platform?: V2ConfigSourcePlatform,
) {
  const { canonical, systemRoot, machineDocument, protectedPath, paths, key, same } =
    v2ConfigSourcePaths(platform);
  const count = Array.isArray(entries) ? entries.length : undefined;
  let index: number | undefined;
  const fail = (code: V2DiagnosticCode): never => {
    throw new V2NativeCompatibilityError(
      "config-source-unverified",
      "native configuration source ordering/policy could not be verified; no machine files or installation target were changed.",
      undefined,
      new V2DiagnosticError("config-sources", code, index, count),
    );
  };
  if (!canonical(root) || paths.dirname(root) === root || protectedPath(root)) fail("source-root");
  if (!Array.isArray(entries) || !entries.length) fail("source-shape");
  if (entries.length > 256) fail("source-bounds");
  try {
    if (Buffer.byteLength(JSON.stringify(entries)) > 2097152) fail("source-bounds");
  } catch (error) {
    if (error instanceof V2NativeCompatibilityError) throw error;
    fail("source-shape");
  }
  const machinePaths = new Set<string>(),
    directories = new Set<string>(),
    files = new Set<string>();
  const early = new Map<string, string>(),
    late = new Set<string>();
  let systemSeen = false,
    preferencesSeen = false,
    systemFileRank = -1;
  let phase: "policies" | "virtual" | "global" | "layers" | "content" | "managed" = "policies";
  let globalSeen = false;
  for (const [i, entry] of entries.entries()) {
    index = i;
    if (!entry || !["directory", "document"].includes(entry.type)) fail("source-shape");
    if (entry.type === "directory") {
      if (!canonical(entry.path) || paths.dirname(entry.path) === entry.path) fail("source-shape");
      if (directories.has(key(entry.path))) fail("source-duplicate");
      directories.add(key(entry.path));
      if (!globalSeen) {
        if (!same(entry.path, root)) fail("source-root");
        globalSeen = true;
        phase = "layers";
      } else if (same(entry.path, systemRoot)) {
        if (profile !== "v2-system-global-config-v1" || preferencesSeen) fail("source-phase");
        systemSeen = true;
        phase = "managed";
      } else if (protectedPath(entry.path) || phase === "managed" || phase === "content")
        fail("source-phase");
      continue;
    }
    if (entry.path !== undefined && !canonical(entry.path)) fail("source-shape");
    if (!entry.info || typeof entry.info !== "object" || Array.isArray(entry.info))
      fail("source-shape");
    const info = entry.info as unknown as Record<string, unknown>;
    try {
      validateV2ConfigControls(info, i, count);
    } catch (error) {
      if (error instanceof V2DiagnosticError) fail(error.diagnostic.code);
      fail("source-shape");
    }
    if (entry.path === undefined) {
      // Public API has no origin discriminator: these are UNATTRIBUTED, not Console/wellknown.
      if (phase === "global" || phase === "managed") fail("source-phase");
      if (!globalSeen) phase = "virtual";
      else phase = "content";
      continue;
    }
    const filename = key(entry.path);
    if (machineDocument(entry.path)) {
      if (profile !== "v2-system-global-config-v1") fail("source-phase");
      machinePaths.add(entry.path);
      if (!globalSeen) {
        if (
          phase !== "policies" ||
          info.policies === undefined ||
          Object.keys(info).some((k) => info[k] !== undefined && k !== "policies")
        )
          fail("source-phase");
        if (early.has(filename)) fail("source-duplicate");
        early.set(filename, entry.path);
      } else {
        if (info.policies !== undefined) fail("source-phase");
        if (late.has(filename)) fail("source-duplicate");
        const systemFile = same(paths.dirname(entry.path), systemRoot);
        if (systemFile) {
          const rank = ["opencode.json", "opencode.jsonc"].findIndex((name) =>
            same(entry.path!, paths.join(systemRoot, name)),
          );
          if (systemSeen || preferencesSeen || rank <= systemFileRank) fail("source-phase");
          systemFileRank = rank;
        } else {
          if (preferencesSeen || (systemFileRank >= 0 && !systemSeen)) fail("source-phase");
          preferencesSeen = true;
        }
        late.add(filename);
        phase = "managed";
      }
      continue;
    }
    if (protectedPath(entry.path)) fail("source-phase");
    if (files.has(filename)) fail("source-duplicate");
    files.add(filename);
    const globalDocument = ["opencode.json", "opencode.jsonc"].some((name) =>
      same(entry.path!, paths.join(root, name)),
    );
    if (!globalSeen) {
      if (!globalDocument) fail("source-root");
      phase = "global";
    } else if (phase === "managed" || phase === "content" || globalDocument) fail("source-phase");
  }
  index = undefined;
  if (!globalSeen) fail("source-root");
  // Repetitions are allowed only for the actual native policies-only / settings split pair.
  if (systemFileRank >= 0 && !systemSeen) fail("source-phase");
  const pairs = [...late].filter((filename) => early.has(filename)).toReversed();
  if (JSON.stringify([...early.keys()]) !== JSON.stringify(pairs)) fail("source-phase");
  return machinePaths;
}

/** Drop unconsumed account/provider fields; controls confer no read/write authority. */
export function projectV2NativeConfigSources(entries: Entries) {
  return entries.map((entry) =>
    entry.type === "directory"
      ? { type: entry.type, path: entry.path }
      : {
          type: entry.type,
          ...(entry.path ? { path: entry.path } : {}),
          info: {
            ...(entry.info.plugins ? { plugins: entry.info.plugins } : {}),
            ...(entry.info.permissions ? { permissions: entry.info.permissions } : {}),
            ...(entry.info.policies ? { policies: entry.info.policies } : {}),
          },
        },
  );
}
