import type {
  DesktopBackendStartReason,
  DesktopLifecycleHintFd,
} from "@bigbud/contracts/server/desktopLifecycleHint.ts";

import type { RuntimeMode, ServerConfigShape } from "../startup/config.ts";

/** Only the desktop composition may consume these explicitly announced descriptors. */
export function desktopLifecycleFields(
  envelope:
    | {
        readonly ownershipHandoff?: boolean | undefined;
        readonly lifecycleHintFd?: DesktopLifecycleHintFd | undefined;
        readonly startReason?: DesktopBackendStartReason | undefined;
      }
    | undefined,
  mode: RuntimeMode,
): Pick<
  ServerConfigShape,
  "desktopStartReason" | "desktopLifecycleHintFd" | "desktopOwnershipHandoff"
> {
  return envelope === undefined || mode !== "desktop"
    ? {}
    : {
        ...(envelope.ownershipHandoff === true ? { desktopOwnershipHandoff: true } : {}),
        ...(envelope.lifecycleHintFd !== undefined
          ? { desktopLifecycleHintFd: envelope.lifecycleHintFd }
          : {}),
        ...(envelope.startReason ? { desktopStartReason: envelope.startReason } : {}),
      };
}
