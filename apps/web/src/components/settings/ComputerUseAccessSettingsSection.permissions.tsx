import { CheckIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import type { DesktopComputerUsePermissionItem } from "@bigbud/contracts";

function formatPermissionLabel(name: string): string {
  switch (name) {
    case "accessibility":
      return "Accessibility";
    case "screen_recording":
      return "Screen Recording";
    case "screen_recording_capturable":
      return "Screen contents capturable";
    default:
      return name.replaceAll("_", " ");
  }
}

export function PermissionStatusGrid({
  permissions,
}: {
  permissions: ReadonlyArray<DesktopComputerUsePermissionItem>;
}) {
  if (permissions.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Permission status is unavailable until the Computer Use runtime is installed.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {permissions.map((permission) => (
        <div
          key={permission.name}
          className="flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs"
        >
          <ShieldAlertIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate">{formatPermissionLabel(permission.name)}</span>
          {permission.granted ? (
            <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
          ) : (
            <XIcon className="size-3.5 shrink-0 text-destructive" />
          )}
        </div>
      ))}
    </div>
  );
}
