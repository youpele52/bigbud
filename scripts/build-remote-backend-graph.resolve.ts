import { posix } from "node:path";

/** Graph-local module resolution over the signed member set. It never consults the build host's
 * filesystem outside the graph, so a package present only on the build machine cannot satisfy
 * an edge. This is a conservative subset of Node's algorithm: anything it cannot prove resolves
 * to `undefined` and is then refused or policy-reviewed by the closure validator. */
export type GraphResolveMode = "import" | "require";
export interface GraphResolveContext {
  readonly members: ReadonlySet<string>;
  readonly readPackageJson: (path: string) => Record<string, unknown> | undefined;
}

const conditions = {
  import: new Set(["node", "import", "module-sync", "default"]),
  require: new Set(["node", "require", "module-sync", "default"]),
} as const;
const requireSuffixes = ["", ".js", ".json", ".node", "/index.js", "/index.json", "/index.node"];

function inside(path: string): string | undefined {
  const normalized = posix.normalize(path);
  return normalized === "." || normalized.startsWith("../") || normalized.startsWith("/")
    ? undefined
    : normalized;
}

function probe(ctx: GraphResolveContext, path: string, mode: GraphResolveMode) {
  const base = inside(path);
  if (!base) return undefined;
  if (mode === "import") return ctx.members.has(base) ? base : undefined;
  for (const suffix of requireSuffixes) if (ctx.members.has(base + suffix)) return base + suffix;
  if (ctx.members.has(`${base}/package.json`)) {
    const main = ctx.readPackageJson(`${base}/package.json`)?.main;
    if (typeof main === "string") return probe(ctx, posix.join(base, main), "require");
  }
  return undefined;
}

function conditional(target: unknown, mode: GraphResolveMode, star?: string): string | null {
  if (typeof target === "string") return star === undefined ? target : target.replaceAll("*", star);
  if (Array.isArray(target)) {
    for (const item of target) {
      const found = conditional(item, mode, star);
      if (found) return found;
    }
    return null;
  }
  if (target && typeof target === "object") {
    for (const [key, value] of Object.entries(target))
      if (conditions[mode].has(key)) {
        const found = conditional(value, mode, star);
        if (found) return found;
      }
  }
  return null;
}

function exported(exports: unknown, subpath: string, mode: GraphResolveMode): string | null {
  const map =
    typeof exports === "string" ||
    Array.isArray(exports) ||
    (exports &&
      typeof exports === "object" &&
      !Object.keys(exports).some((key) => key.startsWith(".")))
      ? { ".": exports }
      : (exports as Record<string, unknown>);
  if (!map || typeof map !== "object") return null;
  if (Object.hasOwn(map, subpath) && !subpath.includes("*")) return conditional(map[subpath], mode);
  let best: { key: string; star: string } | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star < 0 || key.indexOf("*", star + 1) >= 0) continue;
    const prefix = key.slice(0, star),
      suffix = key.slice(star + 1);
    if (
      subpath.length >= key.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      (!best || prefix.length > best.key.indexOf("*"))
    )
      best = { key, star: subpath.slice(prefix.length, subpath.length - suffix.length) };
  }
  return best ? conditional(map[best.key], mode, best.star) : null;
}

function packageName(specifier: string) {
  const parts = specifier.split("/");
  const count = specifier.startsWith("@") ? 2 : 1;
  if (parts.length < count || parts.slice(0, count).some((part) => !part)) return undefined;
  return { name: parts.slice(0, count).join("/"), subpath: parts.slice(count).join("/") };
}

/** Resolve one literal specifier from a graph member. Returns a graph member path or undefined. */
export function resolveGraphSpecifier(
  ctx: GraphResolveContext,
  from: string,
  specifier: string,
  mode: GraphResolveMode,
): string | undefined {
  if (specifier.startsWith("./") || specifier.startsWith("../"))
    return probe(ctx, posix.join(posix.dirname(from), specifier), mode);
  if (
    specifier.startsWith("/") ||
    specifier.startsWith(".") ||
    specifier.includes(":") ||
    specifier.includes("\\")
  )
    return undefined;
  const parsed = packageName(specifier);
  if (!parsed) return undefined;
  for (let dir = posix.dirname(from); ; dir = posix.dirname(dir)) {
    if (posix.basename(dir) !== "node_modules") {
      const pkg = posix.join(dir === "." ? "" : dir, "node_modules", parsed.name);
      const manifest = ctx.members.has(`${pkg}/package.json`)
        ? ctx.readPackageJson(`${pkg}/package.json`)
        : undefined;
      if (manifest) {
        if (manifest.exports !== undefined) {
          const target = exported(
            manifest.exports,
            parsed.subpath ? `./${parsed.subpath}` : ".",
            mode,
          );
          return target?.startsWith("./")
            ? probe(ctx, posix.join(pkg, target), "import")
            : undefined;
        }
        if (parsed.subpath) return probe(ctx, posix.join(pkg, parsed.subpath), mode);
        const main = typeof manifest.main === "string" ? manifest.main : "index.js";
        return probe(ctx, posix.join(pkg, main), "require");
      }
    }
    if (dir === "." || dir === "/" || dir === "") return undefined;
  }
}
