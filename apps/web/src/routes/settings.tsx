import { RotateCcwIcon } from "lucide-react";
import { HeaderBreadcrumb } from "../components/layout/HeaderBreadcrumb";
import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { SETTINGS_NAV_ITEMS } from "../components/settings/SettingsSidebarNav.items";
import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { SettingsSearch } from "../components/settings/SettingsSearch";
import { SettingsSearchProvider } from "../components/settings/SettingsSearch.context";
import {
  readLastSettingsPath,
  rememberSettingsPath,
} from "../components/settings/settingsLastLocation";
import { SettingsPagePathProvider } from "../components/settings/settingsLastLocation.scroll";
import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger, useSidebar } from "../components/ui/sidebar";
import { WINDOW_COLLAPSED_HEADER_INSET_CLASS } from "../components/layout/windowChrome";
import { cn } from "../lib/utils";
import { isElectron } from "../config/env";

function SettingsContentLayout() {
  const [restoreSignal, setRestoreSignal] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(() =>
    setRestoreSignal((value) => value + 1),
  );
  const location = useLocation();
  const { open: sidebarOpen } = useSidebar();
  const showRestoreDefaults = [
    "/settings/general",
    "/settings/notifications",
    "/settings/providers",
    "/settings/ai",
  ].includes(location.pathname);
  useEffect(() => rememberSettingsPath(location.pathname), [location.pathname]);
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--app-shell-pane-fill)] text-foreground">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 sm:px-5">
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <SidebarTrigger className="size-7 shrink-0 md:hidden" />
                <HeaderBreadcrumb parent="Settings" current={activeSectionLabel} />
              </div>
              <SettingsSearch query={searchQuery} onQueryChange={setSearchQuery} />
              <div className="flex items-center justify-end gap-2">
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
          <div className="drag-region grid h-[52px] shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-border px-5">
            <div className="flex min-w-0 items-center gap-1.5">
              {/* Keeps the title clear of the traffic lights and the sidebar toggle. */}
              {!sidebarOpen && (
                <div className={cn("shrink-0", WINDOW_COLLAPSED_HEADER_INSET_CLASS)} />
              )}
              <HeaderBreadcrumb parent="Settings" current={activeSectionLabel} />
            </div>
            <SettingsSearch query={searchQuery} onQueryChange={setSearchQuery} />
            <div className="flex items-center justify-end gap-2">
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

        <SettingsSearchProvider query={searchQuery} terms={[activeSectionLabel]}>
          <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col">
            <SettingsPagePathProvider path={location.pathname}>
              <Outlet />
            </SettingsPagePathProvider>
          </div>
        </SettingsSearchProvider>
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
      // Reopening Settings returns to the last page the user was on.
      throw redirect({ to: readLastSettingsPath(), replace: true });
    }
  },
  component: SettingsRouteLayout,
});
