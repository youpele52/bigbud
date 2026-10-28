import { V2DiagnosticError } from "./PluginSetup.diagnostics.ts";

export interface V2ConfigPolicy {
  readonly action: "provider.use" | "tool.use" | "integration.use";
  readonly resource: string;
  readonly effect: "allow" | "deny";
}
const text = (v: unknown) => typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= 4096;

/** Consumed controls only. Unknown account/provider fields remain opaque and are not carried. */
export function validateV2ConfigControls(
  info: Record<string, unknown>,
  index?: number,
  count?: number,
) {
  const fail = (code: "source-shape" | "permission-unsupported" | "policy-unsupported"): never => {
    throw new V2DiagnosticError("config-controls", code, index, count);
  };
  if (info.permission !== undefined || info.plugin !== undefined) fail("source-shape");
  if (info.plugins !== undefined) {
    if (!Array.isArray(info.plugins) || info.plugins.length > 1000) fail("source-shape");
    for (const plugin of info.plugins as unknown[]) {
      if (text(plugin)) continue;
      if (
        !plugin ||
        typeof plugin !== "object" ||
        Array.isArray(plugin) ||
        !text((plugin as Record<string, unknown>).package)
      )
        fail("source-shape");
    }
  }
  // Native canonical normalization moves experimental.policies to policies. Do not drop a
  // security control if an unnormalized/changed API ever exposes the legacy field instead.
  if (info.experimental && typeof info.experimental === "object" && "policies" in info.experimental)
    fail("policy-unsupported");
  for (const field of ["permissions", "policies"] as const) {
    const rules = info[field];
    if (rules === undefined) continue;
    const code = field === "policies" ? "policy-unsupported" : "permission-unsupported";
    if (!Array.isArray(rules) || rules.length > 1000) fail(code);
    for (const rule of rules as unknown[]) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) fail(code);
      const r = rule as Record<string, unknown>;
      if (
        !text(r.action) ||
        !text(r.resource) ||
        !(field === "policies" ? ["allow", "deny"] : ["allow", "ask", "deny"]).includes(
          r.effect as string,
        ) ||
        Object.keys(r).some((key) => !["action", "resource", "effect"].includes(key)) ||
        (field === "policies" &&
          !["provider.use", "tool.use", "integration.use"].includes(r.action as string))
      )
        fail(code);
    }
  }
}
