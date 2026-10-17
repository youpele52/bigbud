import type { ProviderSession } from "@bigbud/contracts";
import type { PermissionRuleset } from "@opencode/client";

/** Versioned effective policy: native rules alone cannot distinguish canonical Auto edits from supervision on synthetic roots. */
export function v2ExecutionPolicy(
  mode: ProviderSession["runtimeMode"] = "approval-required",
  tools = false,
  permissions: PermissionRuleset = [{ action: "*", resource: "*", effect: "deny" }],
) {
  return Object.freeze({
    version: 2 as const,
    canonicalMode: tools ? mode : ("disabled" as const),
    nativePermissions: Object.freeze(
      permissions.map(({ action, resource, effect }) =>
        Object.freeze({ action, resource, effect }),
      ),
    ),
  });
}
