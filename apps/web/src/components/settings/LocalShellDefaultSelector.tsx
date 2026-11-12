import { useSettings } from "../../hooks/useSettings";
import { BigbudLoader } from "../layout/BigbudLoader";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useLocalShellDefault } from "./useLocalShellDefault";

export function LocalShellDefaultSelector() {
  const selection = useSettings((value) => value.terminalShells.hostDefaults.local);
  const { inventory, loading, saving, error, refresh, save } = useLocalShellDefault();
  const value = selection?.kind === "profile" ? selection.profileId : "legacy-auto";
  const selected = inventory?.profiles.find((profile) => profile.profileId === value);
  const missing = selection?.kind === "profile" && !selected;
  const label =
    value === "legacy-auto"
      ? "Automatic (existing behavior)"
      : (selected?.displayName ?? "Saved profile (unavailable)");
  const enabled = inventory?.localDefaultsEnabled === true;
  return (
    <div className="flex w-full flex-col gap-2 sm:w-72">
      {loading && !inventory ? (
        <div className="h-10">
          <BigbudLoader label="Loading local shells" />
        </div>
      ) : inventory && !enabled ? (
        <span className="text-sm text-muted-foreground">
          Not active on this platform · saved choices preserved
        </span>
      ) : (
        <Select
          value={value}
          disabled={!enabled || loading || saving}
          onValueChange={(next) => {
            if (next === "legacy-auto") void save({ kind: "legacy-auto" });
            else if (
              inventory?.profiles.some(
                (profile) => profile.profileId === next && profile.availability === "available",
              )
            )
              void save({ kind: "profile", profileId: next! });
          }}
        >
          <SelectTrigger
            aria-label="Default local shell"
            variant="muted-outline"
            className="w-full"
          >
            <SelectValue>{label}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="legacy-auto">Automatic (existing behavior)</SelectItem>
            {missing && (
              <SelectItem value={value} disabled>
                Saved profile (unavailable)
              </SelectItem>
            )}
            {inventory?.profiles.map((profile) => (
              <SelectItem
                key={profile.profileId}
                value={profile.profileId}
                disabled={profile.availability !== "available"}
              >
                {profile.displayName}
                {inventory.profiles.filter((entry) => entry.displayName === profile.displayName)
                  .length > 1
                  ? ` (${profile.executable})`
                  : ""}
                {profile.availability !== "available" ? " (unavailable)" : ""}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
      <Button variant="ghost" size="sm" disabled={loading || saving} onClick={() => void refresh()}>
        Refresh local shells
      </Button>
      {saving && (
        <span role="status" className="text-xs text-muted-foreground">
          Saving default shell…
        </span>
      )}
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
