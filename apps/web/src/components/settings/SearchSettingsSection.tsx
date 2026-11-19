import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { SearchIcon } from "lucide-react";

import { updateServerSettings, useSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

/**
 * Mod+F search options (system-wide search plan §6), enforced on the server. "Search this
 * computer" uses the OS index within the File Access scope; it is off by default and disabled
 * while File Access is "No access". Remote search only ever covers project folders.
 */
export function SearchSettingsSection() {
  const search = useSettings((settings) => settings.search);
  const defaults = DEFAULT_UNIFIED_SETTINGS.search;
  const mac = isMacPlatform();
  const noFileAccess = search.fileAccessLevel === "none";
  const thisComputerDescription = !mac
    ? "Searches file names with the system index. Available on macOS first; Windows and Linux follow."
    : noFileAccess
      ? "Uses Spotlight on this Mac. Turn on File Access above to choose which folders it may search."
      : search.fileAccessLevel === "common-folders"
        ? "Uses Spotlight on this Mac, limited to Desktop, Documents, Downloads, Music and Pictures."
        : "Uses Spotlight on this Mac, across your home folders, iCloud Drive and cloud storage.";

  return (
    <SettingsSection title="Search" icon={<SearchIcon className="size-3" />}>
      <SettingsRow
        title="Search this computer"
        description={thisComputerDescription}
        searchTerms={["spotlight", "search", "this computer", "mod+f", "files"]}
        resetAction={
          search.thisComputer !== defaults.thisComputer ? (
            <SettingResetButton
              label="search this computer"
              onClick={() =>
                updateServerSettings({ search: { thisComputer: defaults.thisComputer } })
              }
            />
          ) : undefined
        }
        control={
          <Switch
            tone="success"
            checked={search.thisComputer && !noFileAccess}
            disabled={noFileAccess || !mac}
            onCheckedChange={(checked) =>
              updateServerSettings({ search: { thisComputer: checked } })
            }
            aria-label="Search this computer"
          />
        }
      />
      <SettingsRow
        title="Search connected remote backends"
        description="Includes other projects on connected remote workspaces. Remotes that are not connected are skipped, never dialed."
        searchTerms={["remote", "ssh", "search", "mod+f", "backends"]}
        resetAction={
          search.connectedRemoteBackends !== defaults.connectedRemoteBackends ? (
            <SettingResetButton
              label="search connected remote backends"
              onClick={() =>
                updateServerSettings({
                  search: { connectedRemoteBackends: defaults.connectedRemoteBackends },
                })
              }
            />
          ) : undefined
        }
        control={
          <Switch
            tone="success"
            checked={search.connectedRemoteBackends}
            onCheckedChange={(checked) =>
              updateServerSettings({ search: { connectedRemoteBackends: checked } })
            }
            aria-label="Search connected remote backends"
          />
        }
      />
    </SettingsSection>
  );
}
