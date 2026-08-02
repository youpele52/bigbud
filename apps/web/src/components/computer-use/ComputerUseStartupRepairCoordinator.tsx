import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { useSettings } from "../../hooks/useSettings";
import {
  setDesktopComputerUsePermissionsQueryData,
  setDesktopComputerUseStatusQueryData,
} from "../../lib/desktopComputerUseReactQuery";
import { toastManager } from "../ui/toast";
import {
  getComputerUseStartupPermissionsNotice,
  getComputerUseStartupRuntimeNotice,
} from "./ComputerUseStartupRepair.logic";
import { normalizeComputerUsePermissionMessage } from "./computerUsePermissionMessage";

export function ComputerUseStartupRepairCoordinator() {
  const settings = useSettings();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const hasCheckedStartupRef = useRef(false);

  useEffect(() => {
    if (hasCheckedStartupRef.current) return;
    hasCheckedStartupRef.current = true;
    if (!settings.computerUseEnabled) return;

    const bridge = window.desktopBridge;
    if (!bridge) return;
    let cancelled = false;

    const showNotice = (
      notice: NonNullable<ReturnType<typeof getComputerUseStartupRuntimeNotice>>,
    ) => {
      toastManager.add({
        ...notice,
        timeout: 0,
        data: { hideCopyButton: true },
        actionProps: {
          children: "Open Settings",
          onClick: () => {
            void navigate({ to: "/settings/ai" });
          },
        },
      });
    };

    void (async () => {
      try {
        const runtimeStatus = await bridge.getComputerUseRuntimeStatus();
        if (cancelled) return;
        setDesktopComputerUseStatusQueryData(queryClient, runtimeStatus);
        const runtimeNotice = getComputerUseStartupRuntimeNotice(runtimeStatus);
        if (runtimeNotice) {
          showNotice(runtimeNotice);
          return;
        }

        const permissionsStatus = await bridge.getComputerUsePermissionsStatus();
        if (cancelled) return;
        setDesktopComputerUsePermissionsQueryData(queryClient, permissionsStatus);
        const permissionsNotice = getComputerUseStartupPermissionsNotice(permissionsStatus);
        if (permissionsNotice) showNotice(permissionsNotice);
      } catch (error) {
        if (cancelled) return;
        showNotice({
          type: "error",
          title: "Computer Use needs repair",
          description:
            error instanceof Error
              ? normalizeComputerUsePermissionMessage(error.message)
              : "bigbud could not check the Computer Use runtime.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [navigate, queryClient, settings.computerUseEnabled]);

  return null;
}
