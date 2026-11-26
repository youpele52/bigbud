/**
 * Typed `glob` for the remote workspace bridges: the owner's workspace index
 * (one bounded listing of the root) filtered here with ripgrep `-g` style
 * matching. A pattern without `/` matches a file's base name anywhere below the
 * search directory; a pattern with `/` matches the path relative to it. Supports
 * `**`, `*`, `?`, `[...]` and `{a,b}`.
 *
 * @module http.threadTools.remoteWorkspaceGlob
 */
const MAX_PATTERN_BYTES = 1024;

export function globToRegExp(pattern: string): RegExp {
  if (!pattern || Buffer.byteLength(pattern) > MAX_PATTERN_BYTES)
    throw new Error("The glob pattern is empty or too long.");
  let source = "";
  let braces = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end < 0) throw new Error("Unclosed [ in the glob pattern.");
      const body = pattern
        .slice(index + 1, end)
        .replace(/^!/, "^")
        .replace(/\\/g, "\\\\");
      source += `[${body}]`;
      index = end;
    } else if (char === "{") {
      braces += 1;
      source += "(?:";
    } else if (char === "}" && braces > 0) {
      braces -= 1;
      source += ")";
    } else if (char === "," && braces > 0) source += "|";
    else source += char.replace(/[.+^$()|\\]/g, "\\$&");
  }
  if (braces !== 0) throw new Error("Unbalanced braces in the glob pattern.");
  return new RegExp(`^${source}$`);
}

/** Root-relative index paths under `scope`, matched and returned relative to `scope`. */
export function matchGlob(
  entries: ReadonlyArray<{ readonly path: string; readonly directory: boolean }>,
  scope: string,
  pattern: string,
  limit: number,
): ReadonlyArray<string> {
  const matcher = globToRegExp(pattern);
  const byName = !pattern.includes("/");
  const prefix = scope ? `${scope}/` : "";
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.directory || (prefix && !entry.path.startsWith(prefix))) continue;
    const relative = entry.path.slice(prefix.length);
    const subject = byName ? relative.slice(relative.lastIndexOf("/") + 1) : relative;
    if (matcher.test(subject)) found.push(relative);
    if (found.length >= limit) break;
  }
  return found.toSorted();
}
