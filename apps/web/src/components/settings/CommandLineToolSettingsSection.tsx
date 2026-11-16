import { SquareTerminalIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { commandLineToolToast } from "./CommandLineToolSettingsSection.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** D2: the Settings entry point for the `bigbud` launcher; hidden where it is not offered. */
export function CommandLineToolSettingsSection() {
  const install = window.desktopBridge?.installCommandLineTool;
  const [busy, setBusy] = useState(false);
  const run = useCallback(async () => {
    if (!install) return;
    setBusy(true);
    try {
      toastManager.add({ timeout: 10_000, ...commandLineToolToast(await install()) });
    } catch (error) {
      toastManager.add({
        type: "error",
        timeout: 8_000,
        title: "Unable to install the command-line tool",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setBusy(false);
    }
  }, [install]);
  if (!install) return null;
  return (
    <SettingsSection title="Command line">
      <SettingsRow
        title="Install command-line tool"
        searchTerms={["bigbud command", "CLI", "PATH", "remote-agent"]}
        description="Adds a `bigbud` command in ~/.local/bin that runs this app's bundled CLI, for example `bigbud remote-agent status <host>`. Nothing is downloaded and shell startup files are not edited."
        control={
          <Button
            variant="outline"
            size="sm"
            className="w-full font-normal text-xs"
            disabled={busy}
            onClick={() => void run()}
          >
            <SquareTerminalIcon />
            Install
          </Button>
        }
      />
    </SettingsSection>
  );
}
