import type {
  DesktopComputerUsePermissionItem,
  DesktopComputerUsePermissionSource,
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
  if (Array.isArray(permissions)) {
    return permissions.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.name !== "string" || typeof record.granted !== "boolean") return [];
      return [{ name: record.name, granted: record.granted }];
    });
  }
  const record = structured as Record<string, unknown>;
  return [
    ["accessibility", record.accessibility],
    ["screen_recording", record.screen_recording],
    ["screen_recording_capturable", record.screen_recording_capturable],
  ].flatMap(([name, granted]) =>
    typeof name === "string" && typeof granted === "boolean" ? [{ name, granted }] : [],
  );
}

function parsePermissionSource(result: unknown): DesktopComputerUsePermissionSource | undefined {
  if (!result || typeof result !== "object") return undefined;
  const structured = (result as Record<string, unknown>).structuredContent;
  if (!structured || typeof structured !== "object") return undefined;
  const source = (structured as Record<string, unknown>).source;
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  const attribution = typeof record.attribution === "string" ? record.attribution : null;
  const embedded = typeof record.embedded === "boolean" ? record.embedded : null;
  const hostBundleId = typeof record.host_bundle_id === "string" ? record.host_bundle_id : null;
  return attribution === null && embedded === null && hostBundleId === null
    ? undefined
    : { attribution, embedded, hostBundleId };
}

function allGranted(permissions: ReadonlyArray<DesktopComputerUsePermissionItem>): boolean {
  return permissions.length > 0 && permissions.every((permission) => permission.granted);
}

let checkingPermissions:
  | {
      readonly key: string;
      readonly request: Promise<DesktopComputerUsePermissionsStatus>;
    }
  | undefined;

async function readComputerUsePermissions(input: {
  readonly binaryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<DesktopComputerUsePermissionsStatus> {
  try {
    const result = await callCuaDriverTool(
      input.binaryPath,
      "check_permissions",
      {
        prompt: false,
      },
      input.environment ? { environment: input.environment } : {},
    );
    const permissions = parsePermissionItems(result);
    const message = readTextBlocks(result);
    const source = parsePermissionSource(result);
    return {
      runtimeAvailable: true,
      granted: allGranted(permissions),
      message,
      permissions,
      ...(source ? { source } : {}),
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

export function checkComputerUsePermissions(input: {
  readonly binaryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<DesktopComputerUsePermissionsStatus> {
  const key = [
    input.binaryPath,
    input.environment?.BIGBUD_CUA_ENDPOINT ?? input.environment?.BIGBUD_CUA_DRIVER_SOCKET ?? "",
    input.environment?.BIGBUD_CUA_RUNTIME_GENERATION ?? "",
  ].join("\0");
  if (checkingPermissions?.key === key) {
    return checkingPermissions.request;
  }

  const request = readComputerUsePermissions(input);
  checkingPermissions = { key, request };
  const clearRequest = () => {
    if (checkingPermissions?.request === request) {
      checkingPermissions = undefined;
    }
  };
  void request.then(clearRequest, clearRequest);
  return request;
}

export function pendingHostAccessibilityPermissionsStatus(
  hostBundleId: string,
): DesktopComputerUsePermissionsStatus {
  return {
    runtimeAvailable: true,
    granted: false,
    pendingHostAccessibilityApproval: true,
    message:
      "Enable Accessibility for the current bigbud desktop app in System Settings, then return and check access again.",
    permissions: [{ name: "accessibility", granted: false }],
    source: {
      attribution: "host",
      embedded: true,
      hostBundleId,
    },
  };
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
