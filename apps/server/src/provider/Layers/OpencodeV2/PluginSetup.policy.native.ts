import { V2DiagnosticError } from "./PluginSetup.diagnostics.ts";
import {
  validateV2ConfigControls,
  type V2ConfigPolicy,
} from "./NativeCompatibility.sources.controls.ts";

/** Tagged native Wildcard.match: whole value, slash normalization, dotAll, Windows folding,
 * and the optional trailing command arguments rule. Kept separate from permission matching. */
export function v2NativePolicyMatches(
  value: string,
  pattern: string,
  windows = process.platform === "win32",
) {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp(`^${escaped}$`, windows ? "si" : "s").test(value.replaceAll("\\", "/"));
}

/** Native ManagedPolicy.statements reverses documents, not statements within a document.
 * No origin attribution is available; legacy Console policies remain native-authoritative. */
export function v2NativePolicyStatements(
  infos: readonly Record<string, unknown>[],
): V2ConfigPolicy[] {
  for (const info of infos) validateV2ConfigControls(info);
  return infos.toReversed().flatMap((info) => (info.policies ?? []) as V2ConfigPolicy[]);
}

export function v2NativePolicyDecision(
  policies: readonly V2ConfigPolicy[],
  action: V2ConfigPolicy["action"],
  resource: string,
  windows = process.platform === "win32",
) {
  return (
    policies.findLast(
      (policy) =>
        policy.action === action && v2NativePolicyMatches(resource, policy.resource, windows),
    )?.effect ?? "allow"
  );
}

/** Whether a native glob could match any extension of a fixed action: prefix.
 * An NFA avoids treating the wildcard resource as a literal synthetic event. */
function couldMatchTool(pattern: string, name: string) {
  const windows = process.platform === "win32";
  const normalize = (value: string) => {
    const normalized = value.replaceAll("\\", "/");
    return windows ? normalized.toLowerCase() : normalized;
  };
  const glob = normalize(pattern),
    prefix = normalize(`${name}:`);
  const closure = (input: Set<number>) => {
    const states = new Set(input);
    for (const state of states) if (glob[state] === "*") states.add(state + 1);
    return states;
  };
  let states = closure(new Set([0]));
  for (const char of prefix) {
    const next = new Set<number>();
    for (const state of states) {
      const token = glob[state];
      if (token === "*") next.add(state);
      else if (token === "?" || token === char) next.add(state + 1);
    }
    states = closure(next);
  }
  return states.size > 0;
}

/** The frozen thread bootstrap has no permission.assert call. Do not invent input-resource
 * provenance or change that ABI. This local admission restriction supports full-resource tool
 * controls; potentially relevant resource-scoped cases block as unsupported, never grant.
 * Native ConfigPolicyPlugin evaluates tool.use against permission action:resource (not tool ID alone).
 * Provider/integration policies continue to be enforced by native catalog/permission hooks. */
export function assertV2RequiredToolPolicies(
  infos: readonly Record<string, unknown>[],
  names: readonly string[],
) {
  const policies = v2NativePolicyStatements(infos);
  for (const policy of policies) {
    if (policy.action !== "tool.use" || policy.resource === "*") continue;
    for (const name of names) {
      if (!couldMatchTool(policy.resource, name)) continue;
      // A final unrestricted star can extend a match of the fixed prefix to EVERY resource.
      // Splitting at ':' is not a proof: earlier stars can cross that delimiter. Exclude
      // native's special optional trailing ' *', which does not necessarily cover all suffixes.
      if (
        !policy.resource.endsWith("*") ||
        policy.resource.endsWith(" *") ||
        !v2NativePolicyMatches(`${name}:`, policy.resource)
      )
        throw new V2DiagnosticError("config-controls", "policy-unsupported");
    }
  }
  // The proof makes the match set identical for every suffix. '*' is just a representative
  // suffix here, never inferred native permission-resource provenance.
  for (const name of names)
    if (v2NativePolicyDecision(policies, "tool.use", `${name}:*`) === "deny")
      throw new V2DiagnosticError("config-controls", "policy-denied");
}

const samePolicy = (a: V2ConfigPolicy, b: V2ConfigPolicy) =>
  a.action === b.action && a.resource === b.resource && a.effect === b.effect;

/** Native normalization appends legacy experimental policies then top-level policies, after
 * any generated provider-list controls. Require that exact explicit suffix, in statement order,
 * and no unexplained tool/integration prefix. Provider-only prefixes stay native-authoritative;
 * they neither grant required tools nor imply source provenance. Substitutions/other transforms
 * we cannot reconcile fail closed. Never append raw policies to canonical document precedence. */
export function assertV2RawPolicyProjection(
  raw: Record<string, unknown>,
  canonical: Record<string, unknown>,
) {
  const experimental =
    raw.experimental && typeof raw.experimental === "object" && "policies" in raw.experimental
      ? raw.experimental.policies
      : undefined;
  const explicit: V2ConfigPolicy[] = [];
  for (const policies of [experimental, raw.policies]) {
    if (policies === undefined) continue;
    validateV2ConfigControls({ policies });
    explicit.push(...(policies as V2ConfigPolicy[]));
  }
  validateV2ConfigControls({ policies: canonical.policies });
  const projected = (canonical.policies ?? []) as V2ConfigPolicy[];
  const start = projected.length - explicit.length;
  if (
    start < 0 ||
    projected.slice(0, start).some((policy) => policy.action !== "provider.use") ||
    explicit.some((policy, i) => !samePolicy(policy, projected[start + i]!))
  )
    throw new V2DiagnosticError("config-controls", "policy-unsupported");
}
