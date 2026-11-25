/**
 * Read-only alias resolution for the isolated normal-dev SSH owner profile.
 *
 * This is discovery data, not approval. It reads only owner-private files under
 * the profile root, never spawns a process, never dials, and never evaluates a
 * `Match exec` criterion. `Match all` is folded into global settings; any other
 * `Match` form is reported as a located refusal so a caller can fail closed.
 *
 * The evaluation mirrors OpenSSH's first-value-wins rule for the route hints the
 * picker displays (destination, login, port, host-key alias and route). The Rust
 * owner remains the admission authority: it re-reads the same snapshot and
 * rejects a changed descriptor before any request that could dial.
 *
 * @module sshConfigProfileAliases
 */
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  canonicalSshConfigDirective,
  sshConfigDirectiveRemedy,
} from "./sshOwnerPickerProof.startupDiagnostic.ts";
import { isConcreteSshHostAlias, tokenizeSshConfigLine } from "./sshConfigParse.ts";

export const PROFILE_ALIAS_MAX_INCLUDE_DEPTH = 16;
export const PROFILE_ALIAS_MAX_FILES = 64;
export const PROFILE_ALIAS_MAX_FILE_BYTES = 256 * 1024;

type SourceClass = "user_config" | "user_include";

export interface SshConfigAliasHint {
  readonly alias: string;
  readonly sourcePath: string;
  readonly source: SourceClass;
  readonly line: number;
  readonly hostName?: string;
  readonly user?: string;
  /** Effective port, including OpenSSH's port 22 default. */
  readonly port: string;
  readonly hostKeyAlias?: string;
  /** Human-readable route kind, never a credential path or raw config value. */
  readonly route: string;
}

export interface SshConfigAliasRefusal {
  readonly sourcePath: string;
  readonly source: SourceClass;
  readonly line: number;
  /** Directive keyword, or `unknown` for an unrecognised keyword. */
  readonly directive: string;
  readonly remedy: string;
}

export interface SshConfigProfileResolution {
  readonly hints: ReadonlyArray<SshConfigAliasHint>;
  readonly refusals: ReadonlyArray<SshConfigAliasRefusal>;
  /** Owner-private include files read, relative to the profile root. */
  readonly includes: ReadonlyArray<{ readonly path: string; readonly relative: string }>;
}

interface Directive {
  readonly keyword: string;
  readonly args: ReadonlyArray<string>;
  readonly line: number;
  readonly sourcePath: string;
  readonly source: SourceClass;
}

interface Stanza {
  /** `null` is the global scope; an empty list is a refused Match scope. */
  readonly patterns: ReadonlyArray<string> | null;
  readonly directives: Directive[];
}

interface ParseState {
  readonly root: string;
  readonly visited: Set<string>;
  readonly stanzas: Stanza[];
  readonly refusals: SshConfigAliasRefusal[];
  readonly aliases: Array<Omit<SshConfigAliasHint, "port" | "route">>;
  readonly aliasNames: Set<string>;
  readonly includes: Array<{ path: string; relative: string }>;
  files: number;
}

/** Directives the owner always refuses, even with `none`. */
const ALWAYS_REFUSED = new Set(["LocalCommand"]);
const clampAlias = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;

const invalidProfileFile = () =>
  new Error("Expected an owner-private SSH config inside the disposable profile.");

const refusal = (
  directive: string,
  site: Pick<Directive, "sourcePath" | "source" | "line">,
): SshConfigAliasRefusal => ({
  sourcePath: site.sourcePath,
  source: site.source,
  line: site.line,
  directive,
  remedy: sshConfigDirectiveRemedy(directive),
});

function globMatches(pattern: string, alias: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "iu").test(alias);
}

function stanzaApplies(stanza: Stanza, alias: string): boolean {
  if (stanza.patterns === null) return true;
  let positive = false;
  for (const pattern of stanza.patterns) {
    if (pattern.startsWith("!")) {
      if (globMatches(pattern.slice(1), alias)) return false;
    } else if (globMatches(pattern, alias)) {
      positive = true;
    }
  }
  return positive;
}

function hasGlob(pattern: string): boolean {
  return /[*?]/u.test(pattern);
}

function globToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "u");
}

/** Expands `*`/`?` in trailing path segments, sorted like glob(3). */
async function expandInclude(pattern: string): Promise<ReadonlyArray<string>> {
  if (!hasGlob(pattern)) return [pattern];
  const { root } = path.parse(pattern);
  const segments = pattern
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0);
  let candidates = [root];
  for (const segment of segments) {
    const next: string[] = [];
    for (const directory of candidates) {
      if (!hasGlob(segment)) {
        next.push(path.join(directory, segment));
        continue;
      }
      const entries = await readdir(directory).catch(() => [] as string[]);
      const matcher = globToRegExp(segment);
      for (const name of entries.toSorted()) {
        if (name.startsWith(".") && !segment.startsWith(".")) continue;
        if (matcher.test(name)) next.push(path.join(directory, name));
      }
    }
    candidates = next.slice(0, PROFILE_ALIAS_MAX_FILES);
  }
  return candidates;
}

async function assertPrivateFile(root: string, filePath: string): Promise<string> {
  const info = await lstat(filePath);
  const uid = process.getuid?.();
  if (
    !info.isFile() ||
    (uid !== undefined && info.uid !== uid) ||
    (info.mode & 0o077) !== 0 ||
    info.size > PROFILE_ALIAS_MAX_FILE_BYTES
  )
    throw invalidProfileFile();
  const real = await realpath(filePath);
  const relative = path.relative(root, real);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative))
    throw invalidProfileFile();
  return real;
}

function recordAliases(
  state: ParseState,
  patterns: ReadonlyArray<string>,
  site: Pick<Directive, "sourcePath" | "source" | "line">,
): void {
  for (const alias of patterns) {
    if (!isConcreteSshHostAlias(alias) || !clampAlias.test(alias)) continue;
    if (state.aliasNames.has(alias)) continue;
    state.aliasNames.add(alias);
    state.aliases.push({
      alias,
      sourcePath: site.sourcePath,
      source: site.source,
      line: site.line,
    });
  }
}

async function parseFile(
  state: ParseState,
  content: string,
  filePath: string,
  source: SourceClass,
  enclosing: Stanza,
  depth: number,
): Promise<Stanza> {
  let current = enclosing;
  const lines = content.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  for (const [index, rawLine] of lines.entries()) {
    const token = tokenizeSshConfigLine(rawLine);
    if (!token) continue;
    const site: Directive = {
      keyword: token.keyword,
      args: token.args,
      line: index + 1,
      sourcePath: filePath,
      source,
    };
    if (token.keyword === "host") {
      current = { patterns: token.args, directives: [] };
      state.stanzas.push(current);
      recordAliases(state, token.args, site);
      continue;
    }
    if (token.keyword === "match") {
      if (token.args.join(" ").trim().toLowerCase() === "all") {
        current = { patterns: null, directives: [] };
        state.stanzas.push(current);
      } else {
        // Never evaluate a Match criterion; refuse the whole source explicitly.
        state.refusals.push(refusal("Match", site));
        current = { patterns: [], directives: [] };
        state.stanzas.push(current);
      }
      continue;
    }
    if (token.keyword === "include") {
      current = await followIncludes(state, token.args, site, current, depth);
      continue;
    }
    const canonical = canonicalSshConfigDirective(token.keyword);
    if (!canonical || ALWAYS_REFUSED.has(canonical)) {
      state.refusals.push(refusal(canonical ?? token.keyword, site));
      continue;
    }
    current.directives.push({ ...site, keyword: canonical });
  }
  return current;
}

async function followIncludes(
  state: ParseState,
  patterns: ReadonlyArray<string>,
  site: Directive,
  enclosing: Stanza,
  depth: number,
): Promise<Stanza> {
  if (depth >= PROFILE_ALIAS_MAX_INCLUDE_DEPTH) {
    state.refusals.push(refusal("Include", site));
    return enclosing;
  }
  let current = enclosing;
  for (const pattern of patterns) {
    if (pattern.includes("%") || pattern.includes("${") || pattern.startsWith("~")) {
      state.refusals.push(refusal("Include", site));
      continue;
    }
    const absolute = path.isAbsolute(pattern)
      ? pattern
      : path.join(path.dirname(site.sourcePath), pattern);
    const relative = path.relative(state.root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      state.refusals.push(refusal("Include", site));
      continue;
    }
    for (const candidate of await expandInclude(absolute)) {
      if (state.files >= PROFILE_ALIAS_MAX_FILES) {
        state.refusals.push(refusal("Include", site));
        return current;
      }
      const real = await assertPrivateFile(state.root, candidate).catch(() => undefined);
      if (!real || state.visited.has(real)) continue;
      state.visited.add(real);
      state.files += 1;
      state.includes.push({
        path: real,
        relative: path.relative(state.root, real).split(path.sep).join("/"),
      });
      current = await parseFile(
        state,
        await readFile(real, "utf8"),
        real,
        "user_include",
        current,
        depth + 1,
      );
    }
  }
  return current;
}

function resolveHints(
  stanzas: ReadonlyArray<Stanza>,
  aliases: ReadonlyArray<Omit<SshConfigAliasHint, "port" | "route">>,
): ReadonlyArray<SshConfigAliasHint> {
  return aliases.map((alias) => {
    const values = new Map<string, Directive>();
    for (const stanza of stanzas) {
      if (!stanzaApplies(stanza, alias.alias)) continue;
      for (const directive of stanza.directives) {
        if (!values.has(directive.keyword)) values.set(directive.keyword, directive);
      }
    }
    const value = (keyword: string) => values.get(keyword)?.args[0];
    const jump = value("ProxyJump");
    const command = value("ProxyCommand");
    const hops = jump && jump.toLowerCase() !== "none" ? jump.split(",").length : 0;
    const route =
      hops > 0
        ? `via ${hops} ${hops === 1 ? "hop" : "hops"}`
        : command && command.toLowerCase() !== "none"
          ? "restricted connector"
          : "direct";
    const hostName = value("HostName");
    const user = value("User");
    const hostKeyAlias = value("HostKeyAlias");
    return {
      alias: alias.alias,
      sourcePath: alias.sourcePath,
      source: alias.source,
      line: alias.line,
      ...(hostName ? { hostName } : {}),
      ...(user ? { user } : {}),
      port: value("Port") ?? "22",
      ...(hostKeyAlias ? { hostKeyAlias } : {}),
      route,
    };
  });
}

export interface ResolveProfileAliasesOptions {
  /** Validated profile root; every read stays inside it. */
  readonly root: string;
  /** Absolute path of the top-level profile SSH config. */
  readonly sourcePath: string;
  readonly content: string;
}

/** Resolve route hints for every concrete alias in an isolated profile config. */
export async function resolveProfileAliases({
  root,
  sourcePath,
  content,
}: ResolveProfileAliasesOptions): Promise<SshConfigProfileResolution> {
  const realRoot = await realpath(root);
  const realSource = await realpath(sourcePath);
  const state: ParseState = {
    root: realRoot,
    visited: new Set([realSource]),
    stanzas: [],
    refusals: [],
    aliases: [],
    aliasNames: new Set(),
    includes: [],
    files: 1,
  };
  const global: Stanza = { patterns: null, directives: [] };
  state.stanzas.push(global);
  await parseFile(state, content, realSource, "user_config", global, 0);
  return {
    hints: resolveHints(state.stanzas, state.aliases),
    refusals: state.refusals,
    includes: state.includes,
  };
}

/** One bounded, value-free message for a discovery refusal. */
export function formatProfileAliasRefusal(item: SshConfigAliasRefusal): string {
  const source = item.source.replace("_", " ");
  return `SSH config rejected ${item.directive} in ${source} at line ${item.line}. ${item.remedy}`;
}
