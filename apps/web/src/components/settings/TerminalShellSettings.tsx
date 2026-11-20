import { useSettings } from "../../hooks/useSettings";
import { SettingsRow } from "./settingsLayout";
import { LocalShellDefaultSelector } from "./LocalShellDefaultSelector";

export function TerminalShellSettings() {
  const settings = useSettings((value) => value.terminalShells);
  const defaultsDescription =
    "Choose the shell for new local terminals on this server. Automatic preserves your existing shell behavior. Running terminals and restarts keep their shell; new panes and splits inherit their source pane. Remote defaults are unchanged. Windows defaults remain unavailable until validated.";
  const suggestionsDescription =
    "First-party suggestions are unavailable until shell safety and trusted integration qualification pass. Shell-native suggestions and bindings are unchanged. Runtime capability is not inferred from a shell's name: PowerShell requires verified loaded PSReadLine support, and cmd has no first-party suggestions." +
    (settings.suggestionPolicy === "qualified-history"
      ? " Your saved qualified-history preference is retained but does not enable suggestions."
      : "");
  return (
    <>
      <SettingsRow
        title="Default shell profile"
        description={defaultsDescription}
        control={<LocalShellDefaultSelector />}
      />
      <SettingsRow
        title="Terminal history suggestions"
        description={suggestionsDescription}
        control={<span className="text-sm text-muted-foreground">Off · not qualified</span>}
      />
    </>
  );
}
