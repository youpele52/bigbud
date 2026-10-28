import { authorizedHandle, BROAD_RENDERER_ROLES } from "./ipcAuthorization";
import type {
  DesktopComputerUseInstallResult,
  DesktopComputerUsePermissionsStatus,
  DesktopComputerUseRuntimeStatus,
} from "@bigbud/contracts";

export interface ComputerUseIpcHandlerDeps {
  readonly GET_COMPUTER_USE_RUNTIME_STATUS_CHANNEL: string;
  readonly GET_COMPUTER_USE_PERMISSIONS_STATUS_CHANNEL: string;
  readonly REQUEST_COMPUTER_USE_PERMISSIONS_CHANNEL: string;
  readonly INSTALL_COMPUTER_USE_RUNTIME_CHANNEL: string;
  readonly RUN_COMPUTER_USE_DOCTOR_CHANNEL: string;
  readonly getComputerUseRuntimeStatus: () => Promise<DesktopComputerUseRuntimeStatus>;
  readonly getComputerUsePermissionsStatus: () => Promise<DesktopComputerUsePermissionsStatus>;
  readonly requestHostAccessibilityPermission: () => boolean | null;
  readonly requestComputerUsePermissions: (
    hostAccessibilityTrusted: boolean | null,
  ) => Promise<DesktopComputerUsePermissionsStatus>;
  readonly installComputerUseRuntime: () => Promise<DesktopComputerUseInstallResult>;
  readonly runComputerUseDoctor: () => Promise<DesktopComputerUseRuntimeStatus>;
}

export function registerComputerUseIpcHandlers(deps: ComputerUseIpcHandlerDeps): void {
  authorizedHandle(deps.GET_COMPUTER_USE_RUNTIME_STATUS_CHANNEL, BROAD_RENDERER_ROLES, () =>
    deps.getComputerUseRuntimeStatus(),
  );

  authorizedHandle(deps.GET_COMPUTER_USE_PERMISSIONS_STATUS_CHANNEL, BROAD_RENDERER_ROLES, () =>
    deps.getComputerUsePermissionsStatus(),
  );

  authorizedHandle(deps.REQUEST_COMPUTER_USE_PERMISSIONS_CHANNEL, BROAD_RENDERER_ROLES, () =>
    deps.requestComputerUsePermissions(deps.requestHostAccessibilityPermission()),
  );

  authorizedHandle(deps.INSTALL_COMPUTER_USE_RUNTIME_CHANNEL, BROAD_RENDERER_ROLES, () =>
    deps.installComputerUseRuntime(),
  );

  authorizedHandle(deps.RUN_COMPUTER_USE_DOCTOR_CHANNEL, BROAD_RENDERER_ROLES, () =>
    deps.runComputerUseDoctor(),
  );
}
