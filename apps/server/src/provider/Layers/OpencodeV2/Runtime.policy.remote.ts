import type { PermissionRuleset } from "@opencode/client";
import type { ProviderSession } from "@bigbud/contracts";
import { REMOTE_WORKSPACE_TOOL_NAMES } from "../../../remote-workspace-bridge/remoteWorkspaceTools.ts";
import { V2_THREAD_ACTIONS } from "./Orchestration.protocol.ts";
import { v2OwnerRegistration } from "./Orchestration.registration.ts";

/** Synthetic Locations never authorize native host files, shell, plugins or native children. */
export function v2RemoteToolPolicy(
  mode: ProviderSession["runtimeMode"],
  enabled: boolean,
  serverName: string,
  issuer?: string,
): PermissionRuleset {
  const rules: PermissionRuleset = [{ action: "*", resource: "*", effect: "deny" }];
  if (!enabled) return rules;
  for (const tool of REMOTE_WORKSPACE_TOOL_NAMES) {
    const edit = ["write", "edit", "apply_patch"].includes(tool);
    rules.push({
      action: `${serverName}_${tool}`,
      resource: "*",
      effect: mode === "full-access" || (mode === "auto-accept-edits" && edit) ? "allow" : "ask",
    });
  }
  for (const action of V2_THREAD_ACTIONS) {
    rules.push({ action: `bigbud_thread_v1_${action}`, resource: "*", effect: "allow" });
    if (issuer)
      rules.push({
        action: v2OwnerRegistration({ issuer, bootstrapAbi: "bigbud.thread.bootstrap.v3" }).tool(
          action,
        ),
        resource: "*",
        effect: "allow",
      });
  }
  rules.push({ action: "question", resource: "*", effect: "allow" });
  return rules;
}
