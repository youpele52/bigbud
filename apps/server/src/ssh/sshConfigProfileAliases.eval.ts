import OS from "node:os";

import type { SshConfigAliasRefusal } from "./sshConfigProfileAliases.ts";
import { isOpenSshKeyword } from "./sshConfigOpenSshKeywords.ts";
import { sshConfigDirectiveRemedy } from "./sshOwnerPickerProof.startupDiagnostic.ts";

/**
 * Per-host evaluation for the profile alias resolver (U17), mirroring the owner's
 * `config::include` pass and OpenSSH's single first-value-wins pass:
 *
 * - `Match all|host|originalhost|user|localuser` (with `!`) is evaluated in order against the
 *   route so far. Any other criterion (`exec`, `canonical`, `final`, ...) refuses the host only
 *   while every earlier criterion matched; an earlier false criterion proves the block cannot
 *   apply, as in the owner.
 * - A keyword outside the shared vocabulary refuses only a host whose active blocks contain it,
 *   unless an earlier active `IgnoreUnknown` covers it and OpenSSH itself does not know it.
 *
 * @module sshConfigProfileAliases.eval
 */

type Site = Pick<SshConfigAliasRefusal, "sourcePath" | "source" | "line">;

export interface ProfileDirective extends Site {
  /** Canonical keyword, or `?<lowercase keyword>` for one outside the shared vocabulary. */
  readonly keyword: string;
  readonly args: ReadonlyArray<string>;
}

interface MatchCriterion {
  readonly negated: boolean;
  readonly kind: "host" | "originalhost" | "user" | "localuser" | "unsupported";
  readonly patterns: ReadonlyArray<string>;
}

export type StanzaScope =
  | { readonly kind: "global" }
  | { readonly kind: "host"; readonly patterns: ReadonlyArray<string> }
  | {
      readonly kind: "match";
      readonly criteria: ReadonlyArray<MatchCriterion>;
      readonly site: Site;
    };

export interface Stanza {
  readonly scope: StanzaScope;
  readonly directives: ProfileDirective[];
}

export const profileRefusal = (directive: string, site: Site): SshConfigAliasRefusal => ({
  sourcePath: site.sourcePath,
  source: site.source,
  line: site.line,
  directive,
  remedy: sshConfigDirectiveRemedy(directive),
});

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "iu").test(value);
}

/** OpenSSH pattern-list semantics: a negated match wins, else any positive match. */
export function patternListMatches(patterns: ReadonlyArray<string>, value: string): boolean {
  let positive = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (globMatches(pattern.slice(1), value)) return false;
    } else if (globMatches(pattern, value)) {
      positive = true;
    }
  }
  return positive;
}

const SUPPORTED = new Set(["host", "originalhost", "user", "localuser"]);

/** `Match` arguments as criteria; `all` alone is global scope. */
export function parseMatch(args: ReadonlyArray<string>, site: Site): StanzaScope {
  if (args.length === 1 && args[0]?.toLowerCase() === "all") return { kind: "global" };
  const criteria: MatchCriterion[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const raw = args[index] ?? "";
    const negated = raw.startsWith("!");
    const name = (negated ? raw.slice(1) : raw).toLowerCase();
    const argument = args[index + 1];
    const kind =
      SUPPORTED.has(name) && argument !== undefined
        ? (name as MatchCriterion["kind"])
        : "unsupported";
    criteria.push({ negated, kind, patterns: argument?.split(",") ?? [] });
  }
  if (criteria.length === 0) criteria.push({ negated: false, kind: "unsupported", patterns: [] });
  return { kind: "match", criteria, site };
}

function expandHost(value: string, alias: string): string {
  return value.replace(/%%|%h/gu, (token) => (token === "%h" ? alias : "%")).toLowerCase();
}

export interface HostEvaluation {
  readonly value: (keyword: string) => string | undefined;
  readonly refusals: ReadonlyArray<SshConfigAliasRefusal>;
}

/** One OpenSSH-order pass over every stanza for `host` (the name as given). */
export function evaluateHost(
  stanzas: ReadonlyArray<Stanza>,
  host: string,
  localUser: string = OS.userInfo().username,
): HostEvaluation {
  const values = new Map<string, ProfileDirective>();
  const refusals: SshConfigAliasRefusal[] = [];
  let ignoreUnknown: ReadonlyArray<string> | undefined;
  const current = (keyword: string) => values.get(keyword)?.args[0];
  const matchApplies = (criteria: ReadonlyArray<MatchCriterion>, site: Site): boolean => {
    let active = true;
    for (const criterion of criteria) {
      if (criterion.kind === "unsupported") {
        if (active) {
          refusals.push(profileRefusal("Match", site));
          return false;
        }
        continue;
      }
      const subject =
        criterion.kind === "host"
          ? expandHost(current("HostName") ?? host, host)
          : criterion.kind === "originalhost"
            ? host
            : criterion.kind === "user"
              ? (current("User") ?? localUser)
              : localUser;
      active &&= patternListMatches(criterion.patterns, subject) !== criterion.negated;
    }
    return active;
  };
  for (const stanza of stanzas) {
    const { scope } = stanza;
    const applies =
      scope.kind === "global" ||
      (scope.kind === "host"
        ? patternListMatches(scope.patterns, host)
        : matchApplies(scope.criteria, scope.site));
    if (!applies) continue;
    for (const directive of stanza.directives) {
      if (directive.keyword.startsWith("?")) {
        const name = directive.keyword.slice(1);
        const ignored =
          !isOpenSshKeyword(name) &&
          ignoreUnknown?.some((pattern) => globMatches(pattern, name)) === true;
        if (!ignored) refusals.push(profileRefusal(name, directive));
        continue;
      }
      if (directive.keyword === "IgnoreUnknown") {
        ignoreUnknown ??= directive.args.flatMap((arg) => arg.split(",")).filter(Boolean);
        continue;
      }
      if (!values.has(directive.keyword)) values.set(directive.keyword, directive);
    }
  }
  return { value: current, refusals };
}
