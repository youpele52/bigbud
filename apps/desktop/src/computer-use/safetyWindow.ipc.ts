import { authorizedHandle, SAFETY_RENDERER_ROLES, type IpcRoles } from "../window/ipcAuthorization";
import {
  COMPUTER_USE_NOTICE_ID_MAX_CHARS,
  computerUseSafetyChannels,
  type ComputerUseSafetyStatus,
  type ComputerUseStopAcknowledgement,
} from "./safetyWindow.channels";

/** Main-process authority behind the safety channels (native control once wired). */
export interface ComputerUseSafetyController {
  readonly status: () => ComputerUseSafetyStatus;
  /** Never confirms, never queues behind data work; idempotent. */
  readonly stop: () => Promise<ComputerUseStopAcknowledgement>;
  readonly acknowledgeWarning: (noticeId: string) => boolean;
  readonly openRestrictions: () => void;
}

/**
 * Until the native control channel exists nothing can be admitted, so the
 * honest status is `unavailable` and Stop reports that nothing was revoked.
 */
export function unavailableSafetyController(
  openRestrictions: () => void,
): ComputerUseSafetyController {
  return {
    status: () => ({
      state: "unavailable",
      reason: "control_unavailable",
      noticeId: null,
      noticeState: null,
    }),
    stop: async () => ({ revoked: false, reason: "control_unavailable" }),
    acknowledgeWarning: () => false,
    openRestrictions,
  };
}

/** Status, Stop and warning acknowledgement also serve the in-chat Stop. */
const SAFETY_AND_MAIN: IpcRoles = [...SAFETY_RENDERER_ROLES, "main"];

export function registerComputerUseSafetyIpc(controller: ComputerUseSafetyController): void {
  authorizedHandle(computerUseSafetyChannels.getStatus, SAFETY_AND_MAIN, () => controller.status());
  authorizedHandle(computerUseSafetyChannels.stop, SAFETY_AND_MAIN, () => controller.stop());
  authorizedHandle(
    computerUseSafetyChannels.acknowledgeWarning,
    SAFETY_AND_MAIN,
    (_event, noticeId: unknown) =>
      typeof noticeId === "string" &&
      noticeId.length > 0 &&
      noticeId.length <= COMPUTER_USE_NOTICE_ID_MAX_CHARS &&
      controller.acknowledgeWarning(noticeId),
  );
  // Fixed destination only; the safety renderer has no navigation capability.
  authorizedHandle(computerUseSafetyChannels.openRestrictions, SAFETY_RENDERER_ROLES, () => {
    controller.openRestrictions();
    return true;
  });
}
