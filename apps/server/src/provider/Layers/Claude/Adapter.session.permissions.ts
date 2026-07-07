import type { RuntimeMode } from "@bigbud/contracts";

export function resolveBasePermissionMode(runtimeMode: RuntimeMode | undefined) {
  switch (runtimeMode) {
    case "auto-accept-edits":
      return "acceptEdits" as const;
    case "full-access":
      return "bypassPermissions" as const;
    default:
      return undefined;
  }
}
