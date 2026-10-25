import type { PermissionRuleset } from "@opencode/client";
import { v2PermissionEffect } from "./Runtime.policy.match.ts";

const normalize = (value: string) => {
  const path = value.replaceAll("\\", "/");
  return process.platform === "win32" ? path.toLowerCase() : path;
};
const literal = (pattern: string) => !/[*?]/.test(pattern);
const matches = (pattern: string, value: string) =>
  v2PermissionEffect([{ action: pattern, resource: "*", effect: "allow" }], value, "*") === "allow";

/** Bounded intersection of V2 whole-value wildcard languages; exhaustion is conservatively overlapping. */
function overlaps(left: string, right: string): boolean {
  left = normalize(left);
  right = normalize(right);
  if (literal(left) && literal(right)) return left === right;
  const pending: Array<readonly [number, number]> = [[0, 0]];
  const seen = new Set<string>();
  while (pending.length) {
    const [i, j] = pending.pop()!;
    const key = `${i}:${j}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > 16384) return true;
    if (i === left.length && j === right.length) return true;
    const a = left[i],
      b = right[j];
    if (a === "*") pending.push([i + 1, j]);
    if (b === "*") pending.push([i, j + 1]);
    if (
      a !== undefined &&
      b !== undefined &&
      (a === b || a === "*" || b === "*" || a === "?" || b === "?")
    )
      pending.push([a === "*" ? i : i + 1, b === "*" ? j : j + 1]);
  }
  return false;
}

/** Recognize only provable coverage; partial wildcard coverage must not silently bypass an ask. */
const covers = (rule: string, grant: string) =>
  rule === "*" || normalize(rule) === normalize(grant) || (literal(grant) && matches(rule, grant));

// Native shell-prefix patterns also match the command without arguments.
const resources = (action: string, resource: string) =>
  overlaps(action, "shell") && resource.endsWith(" *")
    ? [resource, resource.slice(0, -2)]
    : [resource];

/** Saved allows cannot override denies. Only a possibly effective ask is a policy conflict. */
export function v2SavedGrantMayBypassAsk(
  rules: PermissionRuleset,
  grant: { readonly action: string; readonly resource: string },
): boolean {
  if (
    !grant.action ||
    !grant.resource ||
    grant.action.length > 4096 ||
    grant.resource.length > 4096
  )
    return true;
  return resources(grant.action, grant.resource).some((resource) => {
    for (const rule of rules.toReversed()) {
      if (!overlaps(rule.action, grant.action)) continue;
      const patterns = resources(grant.action, rule.resource);
      if (!patterns.some((pattern) => overlaps(pattern, resource))) continue;
      // The no-arguments shell alias cannot prove coverage for a non-shell action.
      const coverage = grant.action === "shell" ? patterns : [rule.resource];
      if (
        covers(rule.action, grant.action) &&
        coverage.some((pattern) => covers(pattern, resource))
      )
        return rule.effect === "ask";
      if (rule.effect === "ask") return true;
    }
    return true; // Uncovered native permissions default to ask.
  });
}
