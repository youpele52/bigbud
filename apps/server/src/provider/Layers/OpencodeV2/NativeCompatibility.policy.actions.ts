/** v2.2.5 packages/schema/src/config/policy.ts; unknown security actions remain fail-closed. */
export const V2_NATIVE_POLICY_ACTIONS = [
  "provider.use",
  "tool.use",
  "integration.connect",
  "integration.use",
  "mcp.use",
  "skill.use",
  "plugin.use",
] as const;

export const V2_NATIVE_POLICY_PROJECTION = `policies:${V2_NATIVE_POLICY_ACTIONS.join("|")}:allow|deny`;

export interface V2ConfigPolicy {
  readonly action: (typeof V2_NATIVE_POLICY_ACTIONS)[number];
  readonly resource: string;
  readonly effect: "allow" | "deny";
}

/** Native 2.2.3+ converts only the three legacy integration resource prefixes. */
export function normalizeV2NativePolicy(policy: V2ConfigPolicy): V2ConfigPolicy {
  if (policy.action !== "integration.use") return policy;
  const separator = policy.resource.indexOf(":");
  const prefix = policy.resource.slice(0, separator);
  if (separator < 0 || (prefix !== "mcp" && prefix !== "skill" && prefix !== "plugin"))
    return policy;
  return { ...policy, action: `${prefix}.use`, resource: policy.resource.slice(separator + 1) };
}
