import { ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { SETTINGS_NAV_ITEMS } from "../components/settings/SettingsSidebarNav.items";
import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { isElectron } from "../config/env";

function SettingsContentLayout() {
  const [restoreSignal, setRestoreSignal] = useState(0);
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(() =>
    setRestoreSignal((value) => value + 1),
  );
  const location = useLocation();
  const showRestoreDefaults = [
    "/settings/general",
    "/settings/notifications",
    "/settings/providers",
    "/settings/ai",
  ].includes(location.pathname);
  const activeSectionLabel =
    SETTINGS_NAV_ITEMS.find((item) => item.to === location.pathname)?.label ?? "Settings";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === "Escape" || (mod && event.key === ",")) {
        event.preventDefault();
        window.history.back();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 sm:px-5">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <span className="shrink-0 text-foreground">Settings</span>
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
                <span className="truncate text-muted-foreground">{activeSectionLabel}</span>
              </div>
              <div className="ms-auto flex items-center gap-2">
                {showRestoreDefaults && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={changedSettingLabels.length === 0}
                    onClick={() => void restoreDefaults()}
                  >
                    <RotateCcwIcon className="size-3.5" />
                    Restore defaults
                  </Button>
                )}
              </div>
            </div>
          </header>
        )}

        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
              <span className="shrink-0 text-foreground">Settings</span>
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
              <span className="truncate text-muted-foreground">{activeSectionLabel}</span>
            </div>
            <div className="ms-auto flex items-center gap-2">
              {showRestoreDefaults && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={changedSettingLabels.length === 0}
                  onClick={() => void restoreDefaults()}
                >
                  <RotateCcwIcon className="size-3.5" />
                  Restore defaults
                </Button>
              )}
            </div>
          </div>
        )}

        <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  );
}

function SettingsRouteLayout() {
  return <SettingsContentLayout />;
}

export const Route = createFileRoute("/settings")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsRouteLayout,
});
