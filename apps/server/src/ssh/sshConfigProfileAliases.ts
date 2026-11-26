/**
 * Read-only alias resolution for the isolated normal-dev SSH owner profile.
 *
 * This is discovery data, not approval. It reads only owner-private files under
 * the profile root (production target resolution may also read safe `~/` Includes outside it),
 * never spawns a process, never dials, and never evaluates a `Match exec` criterion.
 * `Match all|host|originalhost|user|localuser` is evaluated per host; any other criterion is a
 * located refusal for a host it could reach, so a caller can fail closed (U17).
 *
 * The evaluation mirrors OpenSSH's first-value-wins rule for the route hints the
 * picker displays (destination, login, port, host-key alias and route). The Rust
 * owner remains the admission authority: it re-reads the same snapshot and
 * rejects a changed descriptor before any request that could dial.
 *
 * @module sshConfigProfileAliases
 */
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { canonicalSshConfigDirective } from "./sshOwnerPickerProof.startupDiagnostic.ts";
import {
  evaluateHost,
  parseMatch,
  profileRefusal as refusal,
  type ProfileDirective as Directive,
  type Stanza,
} from "./sshConfigProfileAliases.eval.ts";
import { isConcreteSshHostAlias, tokenizeSshConfigLine } from "./sshConfigParse.ts";
import {
  assertPrivateFile,
  assertSafeReadableFile,
  expandInclude,
  PROFILE_ALIAS_MAX_FILES,
} from "./sshConfigProfileAliases.files.ts";

export const PROFILE_ALIAS_MAX_INCLUDE_DEPTH = 16;

export type SourceClass = "user_config" | "user_include";

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

/**
 * Credential facts for one host, kept apart from picker hints so a credential
 * path never reaches discovery output. Values are first-effective and unexpanded.
 */
export interface SshConfigHostAuth {
  readonly identityFile?: string;
  readonly userKnownHostsFile?: string;
  /** `none` disables the agent. */
  readonly identityAgent?: string;
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

interface ParseState {
  readonly root: string;
  /** Production mode: the account home for `~/` Includes, which may then leave the root. */
  readonly home: string | undefined;
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
      current = { scope: { kind: "host", patterns: token.args }, directives: [] };
      state.stanzas.push(current);
      recordAliases(state, token.args, site);
      continue;
    }
    if (token.keyword === "match") {
      // Evaluated per host (U17); `exec` and other criteria refuse only a host they could reach.
      current = { scope: parseMatch(token.args, site), directives: [] };
      state.stanzas.push(current);
      continue;
    }
    if (token.keyword === "include") {
      current = await followIncludes(state, token.args, site, current, depth);
      continue;
    }
    const canonical = canonicalSshConfigDirective(token.keyword);
    if (canonical && ALWAYS_REFUSED.has(canonical)) {
      state.refusals.push(refusal(canonical, site));
      continue;
    }
    // An unknown keyword is decided per host (U17: `IgnoreUnknown`, active blocks only).
    current.directives.push({ ...site, keyword: canonical ?? `?${token.keyword.toLowerCase()}` });
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
    const home = pattern.startsWith("~/") ? state.home : undefined;
    if (
      pattern.includes("%") ||
      pattern.includes("${") ||
      (pattern.startsWith("~") && home === undefined)
    ) {
      state.refusals.push(refusal("Include", site));
      continue;
    }
    const absolute = home
      ? path.join(home, pattern.slice(2))
      : path.isAbsolute(pattern)
        ? pattern
        : path.join(path.dirname(site.sourcePath), pattern);
    const relative = path.relative(state.root, absolute);
    if ((relative.startsWith("..") || path.isAbsolute(relative)) && state.home === undefined) {
      state.refusals.push(refusal("Include", site));
      continue;
    }
    for (const candidate of await expandInclude(absolute)) {
      if (state.files >= PROFILE_ALIAS_MAX_FILES) {
        state.refusals.push(refusal("Include", site));
        return current;
      }
      // Production mode reads a user/root-owned file that no other account can write, inside
      // or outside the root (U17); the isolated profile keeps its owner-private rule.
      const real = await (
        state.home === undefined
          ? assertPrivateFile(state.root, candidate)
          : assertSafeReadableFile(candidate)
      ).catch(() => undefined);
      if (!real && state.home !== undefined) {
        state.refusals.push(refusal("Include", site));
        continue;
      }
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
    const { value } = evaluateHost(stanzas, alias.alias);
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
  /** Production target resolution only: the account home for `~/` Includes (U17). */
  readonly home?: string;
}

async function parseProfile({ root, sourcePath, content, home }: ResolveProfileAliasesOptions) {
  const realRoot = await realpath(root);
  const realSource = await realpath(sourcePath);
  const state: ParseState = {
    root: realRoot,
    home,
    visited: new Set([realSource]),
    stanzas: [],
    refusals: [],
    aliases: [],
    aliasNames: new Set(),
    includes: [],
    files: 1,
  };
  const global: Stanza = { scope: { kind: "global" }, directives: [] };
  state.stanzas.push(global);
  await parseFile(state, content, realSource, "user_config", global, 0);
  return state;
}

/** Resolve route hints for every concrete alias in an isolated profile config. */
export async function resolveProfileAliases(
  options: ResolveProfileAliasesOptions,
): Promise<SshConfigProfileResolution> {
  const state = await parseProfile(options);
  // A per-host refusal is reported once, for the first alias it reaches.
  const seen = new Set(state.refusals.map((item) => `${item.sourcePath}:${item.line}`));
  const refusals = [...state.refusals];
  for (const alias of state.aliases) {
    for (const item of evaluateHost(state.stanzas, alias.alias).refusals) {
      const key = `${item.sourcePath}:${item.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        refusals.push(item);
      }
    }
  }
  // Located output stays in source order: files as first seen, lines ascending within each.
  const files = [...new Set(refusals.map((item) => item.sourcePath))];
  const ordered = files.flatMap((file) =>
    refusals.filter((item) => item.sourcePath === file).toSorted((a, b) => a.line - b.line),
  );
  return {
    hints: resolveHints(state.stanzas, state.aliases),
    refusals: ordered,
    includes: state.includes,
  };
}

/**
 * Credential facts plus the route hint for one host. `declared` reports
 * whether a `Host` line names it; an undeclared host still sees `Host *`.
 */
export async function resolveProfileHostAuth(
  options: ResolveProfileAliasesOptions & { readonly host: string },
) {
  const state = await parseProfile(options);
  const declared = state.aliases.find((alias) => alias.alias === options.host);
  const site = declared ?? {
    alias: options.host,
    sourcePath: options.sourcePath,
    source: "user_config" as const,
    line: 0,
  };
  const { value, refusals } = evaluateHost(state.stanzas, options.host);
  const identityFile = value("IdentityFile");
  const userKnownHostsFile = value("UserKnownHostsFile");
  const identityAgent = value("IdentityAgent");
  const auth: SshConfigHostAuth = {
    ...(identityFile ? { identityFile } : {}),
    ...(userKnownHostsFile ? { userKnownHostsFile } : {}),
    ...(identityAgent ? { identityAgent } : {}),
  };
  return {
    declared: declared !== undefined,
    hint: resolveHints(state.stanzas, [site])[0],
    auth,
    refusals: [...state.refusals, ...refusals],
  };
}

/** One bounded, value-free message for a discovery refusal. */
export function formatProfileAliasRefusal(item: SshConfigAliasRefusal): string {
  const source = item.source.replace("_", " ");
  return `SSH config rejected ${item.directive} in ${source} at line ${item.line}. ${item.remedy}`;
}
