import { useCallback, useState } from "react";
import { resolveAndPersistPreferredEditor } from "../../models/editor";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { Button } from "../ui/button";
import { useServerAvailableEditors, useServerKeybindingsConfigPath } from "../../rpc/serverState";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function AdvancedSettingsSection() {
  const keybindingsConfigPath = useServerKeybindingsConfigPath();
  const availableEditors = useServerAvailableEditors();
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);

    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError("No available editors found.");
      setIsOpeningKeybindings(false);
      return;
    }

    void ensureNativeApi()
      .shell.openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [keybindingsConfigPath, availableEditors]);

  return (
    <SettingsSection title="Advanced">
      <SettingsRow
        title="Keybindings"
        description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
        status={
          <>
            <span className="block break-all font-mono text-[11px] text-foreground">
              {keybindingsConfigPath ?? "Resolving keybindings path..."}
            </span>
            {openKeybindingsError ? (
              <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
            ) : (
              <span className="mt-1 block">Opens in your preferred editor.</span>
            )}
          </>
        }
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={!keybindingsConfigPath || isOpeningKeybindings}
            onClick={openKeybindingsFile}
          >
            {isOpeningKeybindings ? "Opening..." : "Open file"}
          </Button>
        }
      />
    </SettingsSection>
  );
}
