import { ipcMain } from "electron";
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
  readonly requestComputerUsePermissions: () => Promise<DesktopComputerUsePermissionsStatus>;
  readonly installComputerUseRuntime: () => Promise<DesktopComputerUseInstallResult>;
  readonly runComputerUseDoctor: () => Promise<DesktopComputerUseRuntimeStatus>;
}

export function registerComputerUseIpcHandlers(deps: ComputerUseIpcHandlerDeps): void {
  ipcMain.removeHandler(deps.GET_COMPUTER_USE_RUNTIME_STATUS_CHANNEL);
  ipcMain.handle(deps.GET_COMPUTER_USE_RUNTIME_STATUS_CHANNEL, () =>
    deps.getComputerUseRuntimeStatus(),
  );

  ipcMain.removeHandler(deps.GET_COMPUTER_USE_PERMISSIONS_STATUS_CHANNEL);
  ipcMain.handle(deps.GET_COMPUTER_USE_PERMISSIONS_STATUS_CHANNEL, () =>
    deps.getComputerUsePermissionsStatus(),
  );

  ipcMain.removeHandler(deps.REQUEST_COMPUTER_USE_PERMISSIONS_CHANNEL);
  ipcMain.handle(deps.REQUEST_COMPUTER_USE_PERMISSIONS_CHANNEL, () =>
    deps.requestComputerUsePermissions(),
  );

  ipcMain.removeHandler(deps.INSTALL_COMPUTER_USE_RUNTIME_CHANNEL);
  ipcMain.handle(deps.INSTALL_COMPUTER_USE_RUNTIME_CHANNEL, () => deps.installComputerUseRuntime());

  ipcMain.removeHandler(deps.RUN_COMPUTER_USE_DOCTOR_CHANNEL);
  ipcMain.handle(deps.RUN_COMPUTER_USE_DOCTOR_CHANNEL, () => deps.runComputerUseDoctor());
}
