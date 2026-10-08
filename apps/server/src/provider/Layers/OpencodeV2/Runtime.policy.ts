import type { PermissionRuleset } from "@opencode/client";
import type { ProviderSession } from "@bigbud/contracts";
import { V2_CODING_TOOLS } from "./Coding.plugin.ts";

export interface V2ToolPolicyContext {
  readonly nativeWorkspace: boolean;
  readonly profileRoot: string;
  readonly boundedFiles: boolean;
}

/** Native approval/Full access has V1 host-user trust, NOT kernel containment. Synthetic Locations never gain it. */
export function v2LocalToolPolicy(
  mode: ProviderSession["runtimeMode"],
  enabled: boolean,
  coding = false,
  context?: V2ToolPolicyContext,
): PermissionRuleset {
  const deny: PermissionRuleset = [{ action: "*", resource: "*", effect: "deny" }];
  if (!enabled) return deny;
  const native: PermissionRuleset = context?.nativeWorkspace
    ? [
        ...["read", "glob", "grep", "shell", "skill"].map((action) => ({
          action,
          resource: "*",
          effect: mode === "full-access" ? ("allow" as const) : ("ask" as const),
        })),
        {
          action: "edit",
          resource: "*",
          effect:
            mode === "full-access"
              ? "allow"
              : mode === "auto-accept-edits" && context.boundedFiles
                ? "deny"
                : "ask",
        },
        { action: "external_directory", resource: "*", effect: "ask" },
        // Native direct file grants never authorize owned runtime storage/config edits.
        ...["read", "edit", "external_directory"].flatMap((action) => [
          { action, resource: context.profileRoot.replaceAll("\\", "/"), effect: "deny" as const },
          {
            action,
            resource: `${context.profileRoot.replaceAll("\\", "/")}/*`,
            effect: "deny" as const,
          },
        ]),
        ...[".git", ".opencode", ".agents", ".bigbud"].flatMap((name) =>
          [name, `${name}/*`, `*/${name}`, `*/${name}/*`].map((resource) => ({
            action: "edit",
            resource,
            effect: "deny" as const,
          })),
        ),
      ]
    : [];
  return [
    ...deny,
    ...native,
    ...(coding
      ? ["bigbud_coding", ...V2_CODING_TOOLS.map((name) => `bigbud_${name}`)].map((action) => ({
          action,
          resource: "*",
          effect: "allow" as const,
        }))
      : []),
    ...["webfetch", "websearch", "question"].map((action) => ({
      action,
      resource: "*",
      effect:
        action === "question" || mode === "full-access" ? ("allow" as const) : ("ask" as const),
    })),
  ];
}

export const V2_LOCAL_TOOL_LIMITATION =
  "Preview access modes: co-located native commands/files use explicit approvals; Full access trusts ordinary native tools with host-user filesystem/process/network authority (not a sandbox), with external-directory requests still explicit. Auto accept edits automatically permits only bounded canonical write/edit; other actions still ask. Windows without the bounded file helper asks for native edits instead. Synthetic remote Locations never gain native filesystem/shell access. bigbud_shell remains the optional macOS no-fork/no-network contained command tool. Unknown native plugins/MCP/children remain denied; canonical delegated threads retain independent ownership. Remote absent-create CAS/handle-close are unsupported by the current agent protocol.";
