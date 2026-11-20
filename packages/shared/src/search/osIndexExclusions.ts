/**
 * Default privacy exclusions (system-wide search plan §8), shared with the Rust agent: the agent
 * embeds `osIndexExclusions.json` with `include_str!` and drops matching "this computer" results;
 * TypeScript uses the same list to refuse handing excluded paths to the OS default handler.
 *
 * Matching mirrors the agent: `*`-only globs, ASCII case-insensitive. Folder patterns
 * (`pathSegments`) match a run of consecutive components anywhere in the path. File-name
 * patterns match the final name and every component below the home folder, so a folder such as
 * `~/secrets` hides its whole subtree while a user or volume name never hides everything.
 */
import exclusions from "./osIndexExclusions.json" with { type: "json" };

interface ExclusionList {
  readonly pathSegments: ReadonlyArray<ReadonlyArray<string>>;
  readonly fileNames: ReadonlyArray<string>;
}

function strings(items: unknown): boolean {
  return (
    Array.isArray(items) &&
    items.length > 0 &&
    items.every((item) => typeof item === "string" && item.length > 0)
  );
}

function parse(value: unknown): ExclusionList | null {
  const list = value as { pathSegments?: unknown; fileNames?: unknown } | null;
  if (!list || !strings(list.pathSegments) || !strings(list.fileNames)) return null;
  const pathSegments = (list.pathSegments as string[]).map((pattern) => pattern.split("/"));
  const fileNames = list.fileNames as string[];
  const validSegments = pathSegments.every((parts) =>
    parts.every((part) => part.length > 0 && part !== "." && part !== ".."),
  );
  if (!validSegments || fileNames.some((name) => name.includes("/"))) return null;
  return { pathSegments, fileNames };
}

const EMBEDDED = parse(exclusions);

function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** `*`-only glob, ASCII case-insensitive, iterative with one backtrack point (no recursion). */
export function exclusionGlobMatches(pattern: string, text: string): boolean {
  const p = lowerAscii(pattern);
  const t = lowerAscii(text);
  let pi = 0;
  let ti = 0;
  let star: { readonly p: number; readonly t: number } | null = null;
  for (;;) {
    if (pi < p.length && p[pi] === "*") {
      star = { p: pi, t: ti };
      pi += 1;
    } else if (pi < p.length && ti < t.length && p[pi] === t[ti]) {
      pi += 1;
      ti += 1;
    } else if (pi === p.length && ti === t.length) {
      return true;
    } else if (star && star.t < t.length) {
      star = { p: star.p, t: star.t + 1 };
      pi = star.p + 1;
      ti = star.t;
    } else {
      return false;
    }
  }
}

function components(path: string): string[] {
  return path.split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
}

function belowHome(parts: readonly string[], home: string | undefined): readonly string[] {
  if (!home) return [];
  const homeParts = components(home);
  const inside =
    homeParts.length > 0 &&
    homeParts.length < parts.length &&
    homeParts.every((part, index) => lowerAscii(part) === lowerAscii(parts[index] ?? ""));
  return inside ? parts.slice(homeParts.length) : [];
}

/**
 * Whether bigbud must refuse to expose `absolutePath` outside a project (system open, loose-file
 * preview). A damaged embedded list fails closed: every path counts as excluded.
 */
export function isOsIndexExcludedPath(absolutePath: string, home?: string): boolean {
  if (!EMBEDDED) return true;
  const parts = components(absolutePath);
  const segmentMatch = EMBEDDED.pathSegments.some((pattern) =>
    parts.some(
      (_, start) =>
        start + pattern.length <= parts.length &&
        pattern.every((part, offset) => exclusionGlobMatches(part, parts[start + offset] ?? "")),
    ),
  );
  if (segmentMatch) return true;
  const names = new Set([...belowHome(parts, home), parts.at(-1) ?? ""]);
  return [...names].some((name) =>
    EMBEDDED.fileNames.some((pattern) => exclusionGlobMatches(pattern, name)),
  );
}
