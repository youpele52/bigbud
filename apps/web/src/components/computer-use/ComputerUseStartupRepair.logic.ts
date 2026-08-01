import type {
  DesktopComputerUsePermissionsStatus,
  DesktopComputerUseRuntimeStatus,
} from "@bigbud/contracts";
import { normalizeComputerUsePermissionMessage } from "./computerUsePermissionMessage";

export interface ComputerUseStartupRepairNotice {
  readonly title: string;
  readonly description: string;
  readonly type: "error" | "warning";
}

function formatPermissionName(name: string): string {
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

export function getComputerUseStartupRuntimeNotice(
  status: DesktopComputerUseRuntimeStatus,
): ComputerUseStartupRepairNotice | null {
  if (!status.repairRequired) return null;
  return {
    type: "error",
    title: "Computer Use needs repair",
    description: status.message
      ? normalizeComputerUsePermissionMessage(status.message)
      : "The desktop automation runtime is not ready. Open Settings to repair it.",
  };
}

export function getComputerUseStartupPermissionsNotice(
  status: DesktopComputerUsePermissionsStatus,
): ComputerUseStartupRepairNotice | null {
  if (status.granted) return null;
  if (!status.runtimeAvailable || status.permissions.length === 0) {
    return {
      type: "error",
      title: "Computer Use needs repair",
      description: status.message
        ? normalizeComputerUsePermissionMessage(status.message)
        : "bigbud could not check desktop permissions. Open Settings to repair Computer Use.",
    };
  }

  const missingPermissions = status.permissions.filter((permission) => !permission.granted);
  return {
    type: "warning",
    title: "Desktop permissions needed",
    description: status.message
      ? normalizeComputerUsePermissionMessage(status.message)
      : missingPermissions
          .map((permission) => `${formatPermissionName(permission.name)}: not granted.`)
          .join("\n") ||
        "Approve the required desktop permissions to finish enabling Computer Use.",
  };
}
