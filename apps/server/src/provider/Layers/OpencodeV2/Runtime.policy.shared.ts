import path from "node:path";
import os from "node:os";
import type { PermissionRuleset } from "@opencode/client";
import type { ProviderSession } from "@bigbud/contracts";

/** Native host-user trust, not a sandbox; policy changes affect this owned session only. */
export function v2SharedToolPolicy(
  mode: ProviderSession["runtimeMode"],
  database: string,
  enabled: boolean,
): PermissionRuleset {
  if (!enabled) return [{ action: "*", resource: "*", effect: "deny" }];
  const home = os.homedir();
  const protectedPaths = [
    path.dirname(database),
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "opencode"),
    path.join(process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "opencode"),
  ];
  return [
    { action: "*", resource: "*", effect: mode === "full-access" ? "allow" : "ask" },
    { action: "edit", resource: "*", effect: mode === "approval-required" ? "ask" : "allow" },
    { action: "question", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "ask" },
    // Native children lack canonical bigbud ownership; never impersonate delegated app threads.
    { action: "subagent", resource: "*", effect: "deny" },
    ...protectedPaths.flatMap((root) =>
      [root, `${root}/*`].flatMap((resource) =>
        ["read", "edit", "external_directory"].map((action) => ({
          action,
          resource,
          effect: "deny" as const,
        })),
      ),
    ),
  ];
}
