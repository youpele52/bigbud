import { ServerIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { isBoundBackendWindow } from "../../rpc/backendScope.state";
import { readNativeApi } from "../../rpc/nativeApi";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarMenu, SidebarMenuItem } from "../ui/sidebar";
import { SIDEBAR_COMPACT_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import {
  loadRemoteBackendEntry,
  remoteBackendUnavailableLabel,
  type RemoteBackendEntryState,
} from "./SidebarRemoteBackends.logic";

function readEntry() {
  return loadRemoteBackendEntry({
    isBoundWindow: isBoundBackendWindow(),
    canOpenWindow: typeof window.desktopBridge?.openRemoteBackendWindow === "function",
    list: readNativeApi()?.server.listRemoteBackendRelayProfiles,
  });
}

/** "Open remote backend": shown only when installed backend profiles exist. Each profile opens
 * (or focuses) its own bound window; the list is re-read whenever the menu opens. */
export function SidebarRemoteBackends() {
  const [entry, setEntry] = useState<RemoteBackendEntryState>({ status: "loading" });
  // Once profiles were seen the entry stays, so a later empty listing shows its typed reason.
  const [shown, setShown] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(() => {
    let live = true;
    void readEntry().then((next) => {
      if (!live) return;
      setEntry(next);
      if (next.status === "available") setShown(true);
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(refresh, [refresh]);

  if (!shown) return null;
  const unavailable =
    entry.status === "unavailable" ? remoteBackendUnavailableLabel(entry.reason) : null;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Menu
          onOpenChange={(open) => {
            if (!open) return;
            setNotice(null);
            refresh();
          }}
        >
          <MenuTrigger className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground">
            <ServerIcon className={SIDEBAR_COMPACT_ICON_SIZE_CLASS} />
            <span className="text-xs">Open remote backend</span>
          </MenuTrigger>
          <MenuPopup align="start" side="top" className="min-w-52">
            {(entry.status === "available" ? entry.profiles : []).map((profile) => (
              <MenuItem
                key={profile.profileId}
                className="min-h-7 py-1 text-xs"
                onClick={() => {
                  void window.desktopBridge
                    ?.openRemoteBackendWindow?.(profile.profileId)
                    .then((result) => {
                      if (result.status === "unavailable")
                        setNotice(remoteBackendUnavailableLabel(result.reason));
                    });
                }}
              >
                <span className="truncate text-xs">{profile.label}</span>
              </MenuItem>
            ))}
            {(notice ?? unavailable) ? (
              <p role="status" className="px-2 py-1 text-xs text-amber-600 dark:text-amber-400">
                {notice ?? unavailable}
              </p>
            ) : null}
          </MenuPopup>
        </Menu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
