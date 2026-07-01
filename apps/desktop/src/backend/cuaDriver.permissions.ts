import type {
  DesktopComputerUsePermissionItem,
  DesktopComputerUsePermissionsStatus,
} from "@bigbud/contracts";

import { callCuaDriverTool } from "./cuaDriver.mcpClient";

function readTextBlocks(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const block = entry as Record<string, unknown>;
    return typeof block.text === "string" ? [block.text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

function parsePermissionItems(result: unknown): ReadonlyArray<DesktopComputerUsePermissionItem> {
  if (!result || typeof result !== "object") {
    return [];
  }
  const structured = (result as Record<string, unknown>).structuredContent;
  if (!structured || typeof structured !== "object") {
    return [];
  }
  const permissions = (structured as Record<string, unknown>).permissions;
  if (!Array.isArray(permissions)) {
    return [];
  }
  return permissions.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.granted !== "boolean") {
      return [];
    }
    return [{ name: record.name, granted: record.granted }];
  });
}

function allGranted(permissions: ReadonlyArray<DesktopComputerUsePermissionItem>): boolean {
  return permissions.length > 0 && permissions.every((permission) => permission.granted);
}

export async function checkComputerUsePermissions(input: {
  readonly binaryPath: string;
  readonly prompt: boolean;
}): Promise<DesktopComputerUsePermissionsStatus> {
  try {
    const result = await callCuaDriverTool(
      input.binaryPath,
      "check_permissions",
      input.prompt ? { prompt: true } : {},
    );
    const permissions = parsePermissionItems(result);
    const message = readTextBlocks(result);
    return {
      runtimeAvailable: true,
      granted: allGranted(permissions),
      message,
      permissions,
    };
  } catch (error) {
    return {
      runtimeAvailable: true,
      granted: false,
      message: error instanceof Error ? error.message : "Failed to check desktop permissions.",
      permissions: [],
    };
  }
}

export function missingComputerUsePermissionsStatus(
  message: string,
): DesktopComputerUsePermissionsStatus {
  return {
    runtimeAvailable: false,
    granted: false,
    message,
    permissions: [],
  };
}
