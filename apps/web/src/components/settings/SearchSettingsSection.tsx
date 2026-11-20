import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { SearchIcon } from "lucide-react";

import { updateServerSettings, useSettings } from "../../hooks/useSettings";
import { ensureFileAccessProbed } from "../../hooks/useSettings.fileAccessProbe";
import { currentOsIndexSource, osIndexWording } from "../../lib/osIndexWording";
import { Switch } from "../ui/switch";
import { SETTINGS_ANCHORS, SettingsAnchorLink, useSettingsAnchorTarget } from "./settingsAnchor";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

/** "Search this computer" description for this platform's OS index and the File Access level. */
export function describeThisComputerSearch(
  source: ReturnType<typeof currentOsIndexSource>,
  fileAccessLevel: "none" | "common-folders" | "unrestricted",
): string {
  if (source === null) {
    return "Searches file names with the system file index. Not available on this system yet.";
  }
  const { index, place, staleNote } = osIndexWording(source);
  const scope =
    fileAccessLevel === "none"
      ? `Uses ${index} on ${place}. Turn on File Access above to choose which folders it may search.`
      : fileAccessLevel === "common-folders"
        ? `Uses ${index} on ${place}, limited to Desktop, Documents, Downloads, Music and Pictures.`
        : source === "spotlight"
          ? `Uses ${index} on ${place}, across your home folders, iCloud Drive and cloud storage.`
          : `Uses ${index} on ${place}, across your home folders.`;
  return staleNote ? `${scope} ${staleNote}` : scope;
}

/**
 * Mod+F and Mod+P search options (system-wide search plan §6), enforced on the server. "Search
 * this computer" uses the OS index within the File Access scope; it is on by default but stays
 * off and disabled while File Access is "No access". Remote search only ever covers project
 * folders and registered remote folders.
 */
export function SearchSettingsSection() {
  const search = useSettings((settings) => settings.search);
  const defaults = DEFAULT_UNIFIED_SETTINGS.search;
  const source = currentOsIndexSource();
  const noFileAccess = search.fileAccessLevel === "none";
  const targeted = useSettingsAnchorTarget(SETTINGS_ANCHORS.searchThisComputer);
  const thisComputerDescription = describeThisComputerSearch(source, search.fileAccessLevel);

  return (
    <SettingsSection title="Search" icon={<SearchIcon className="size-3" />}>
      <SettingsRow
        id={SETTINGS_ANCHORS.searchThisComputer}
        forceVisible={targeted}
        title="Search this computer"
        description={thisComputerDescription}
        status={
          <span>
            Follows the File Access permission level; unavailable while it is "No access".{" "}
            <SettingsAnchorLink anchorId={SETTINGS_ANCHORS.fileAccessPermissionLevel}>
              Go to File Access
            </SettingsAnchorLink>
          </span>
        }
        searchTerms={[
          "spotlight",
          "windows search",
          "locate",
          "search",
          "this computer",
          "mod+f",
          "mod+p",
          "files",
        ]}
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
            disabled={noFileAccess || source === null}
            onCheckedChange={(checked) => {
              updateServerSettings({ search: { thisComputer: checked } });
              // Surfaces any macOS privacy prompt now rather than on the first search.
              if (checked) ensureFileAccessProbed(search.fileAccessLevel);
            }}
            aria-label="Search this computer"
          />
        }
      />
      <SettingsRow
        title="Search connected remote backends"
        description="Includes other projects on connected remote workspaces. Remotes that are not connected are skipped, never dialed."
        searchTerms={["remote", "ssh", "search", "mod+f", "mod+p", "backends"]}
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
