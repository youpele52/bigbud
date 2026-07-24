import type {
  DesktopComputerUsePermissionsStatus,
  DesktopComputerUseRuntimeStatus,
} from "@bigbud/contracts";

export interface ComputerUseStartupRepairNotice {
  readonly title: string;
  readonly description: string;
  readonly type: "error" | "warning";
}

export function getComputerUseStartupRuntimeNotice(
  status: DesktopComputerUseRuntimeStatus,
): ComputerUseStartupRepairNotice | null {
  if (!status.repairRequired) return null;
  return {
    type: "error",
    title: "Computer Use needs repair",
    description:
      status.message ?? "The desktop automation runtime is not ready. Open Settings to repair it.",
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
      description:
        status.message ??
        "bigbud could not check desktop permissions. Open Settings to repair Computer Use.",
    };
  }
  return {
    type: "warning",
    title: "Desktop permissions needed",
    description:
      status.message ?? "Approve the required desktop permissions to finish enabling Computer Use.",
  };
}
