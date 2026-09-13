import { Input } from "../ui/input";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { SettingsRow } from "./settingsLayout";
import {
  resolveSelectedMobileWebUrl,
  type MobileWebUrlSelection,
} from "./mobileRemoteControl.urls";

export function MobileRemoteUrlSelection(props: {
  selection: MobileWebUrlSelection;
  onChange: (selection: MobileWebUrlSelection) => void;
  liveUrl: string | null;
  isDiscovering: boolean;
}) {
  const { selection, onChange, liveUrl, isDiscovering } = props;
  return (
    <SettingsRow
      title="Mobile app URL"
      description="Base URL of the mobile companion. Pairing links add /mobile automatically."
    >
      <div className="mt-3 space-y-3">
        <Input
          aria-label="Mobile app URL"
          value={
            selection.mode === "custom"
              ? selection.customUrl
              : (resolveSelectedMobileWebUrl(selection, liveUrl) ?? "")
          }
          placeholder={
            selection.mode === "local"
              ? "Waiting for the local mobile app"
              : "https://mobile.bigbud.app"
          }
          onChange={(event) => onChange({ mode: "custom", customUrl: event.target.value })}
        />
        <ToggleGroup
          value={[selection.mode]}
          onValueChange={(values) => {
            const mode = values[0];
            if (mode === "hosted" || mode === "local" || mode === "custom") {
              onChange({ ...selection, mode });
            }
          }}
        >
          <ToggleGroupItem value="hosted">bigbud</ToggleGroupItem>
          {import.meta.env.DEV ? <ToggleGroupItem value="local">Local</ToggleGroupItem> : null}
          <ToggleGroupItem value="custom">Custom</ToggleGroupItem>
        </ToggleGroup>
        {import.meta.env.DEV ? (
          <p role="status" className="break-all text-xs text-muted-foreground">
            {selection.mode !== "local"
              ? "Select Local to check for a running mobile app."
              : liveUrl
                ? `Local mobile app running at ${liveUrl}.`
                : isDiscovering
                  ? "Checking for a running local mobile app..."
                  : "Local mobile app unavailable. Start bun dev:mobile-web to use Local."}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}
