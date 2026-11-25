import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";

export function resolveServerPublishDependencies(
  dependencies: Readonly<Record<string, string>>,
  catalog: Readonly<Record<string, unknown>>,
): Record<string, string> {
  // tsdown inlines effect-acp's implementation; it is not a runtime package lookup.
  // Only omit this exact workspace declaration, not an alias or a future registry version.
  const { "effect-acp": effectAcp, ...runtimeDependencies } = dependencies;
  if (effectAcp !== undefined && effectAcp !== "workspace:*") {
    throw new Error(`Unexpected publish dependency 'effect-acp': '${effectAcp}'.`);
  }

  const resolved = resolveCatalogDependencies(runtimeDependencies, catalog, "apps/server publish");
  return Object.fromEntries(
    Object.entries(resolved).map(([name, spec]) => {
      // This manifest accepts registry ranges/tags, not workspace packages, aliases,
      // local paths or other protocol references (including those from the catalog).
      if (
        name.startsWith("@bigbud/") ||
        typeof spec !== "string" ||
        spec.trim() === "" ||
        spec.trimStart().startsWith(".") ||
        /[:/\\]|\.(?:tgz|tar(?:\.gz)?)\s*$/i.test(spec)
      ) {
        throw new Error(`Unsupported publish dependency '${name}': '${String(spec)}'.`);
      }
      return [name, spec];
    }),
  );
}
