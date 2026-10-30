import {
  DEFAULT_ITUTU_IDLE_TIMEOUT_MINUTES,
  ITUTU_IDLE_TIMEOUT_MAX_MINUTES,
  ITUTU_IDLE_TIMEOUT_MIN_MINUTES,
  type ItutuIdleDestination,
  type ServerSettingsPatch,
} from "@bigbud/contracts/settings";
import { useEffect, useState } from "react";

import { persistServerSettings, useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  ITUTU_IDLE_DESTINATION_LABELS,
  resolveIdleTimeoutDraft,
} from "./ItutuIdleSettingsSection.logic";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Ìtútù idle cleanup. The server owns the policy, so a change shows only once it is saved.
 * Turning it on or changing it gives every thread a full new timeout.
 */
export function ItutuIdleSettingsSection() {
  const enabled = useSettings((settings) => settings.itutuIdleCleanupEnabled);
  const timeoutMinutes = useSettings((settings) => settings.itutuIdleTimeoutMinutes);
  const destination = useSettings((settings) => settings.itutuIdleDestination);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(String(timeoutMinutes));

  useEffect(() => setDraft(String(timeoutMinutes)), [timeoutMinutes]);

  const save = async (patch: ServerSettingsPatch) => {
    setSaving(true);
    try {
      await persistServerSettings(patch);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't save idle thread settings",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setSaving(false);
    }
  };

  const commitTimeout = () => {
    const next = resolveIdleTimeoutDraft(draft, timeoutMinutes);
    if (next === null) setDraft(String(timeoutMinutes));
    else void save({ itutuIdleTimeoutMinutes: next });
  };

  return (
    <SettingsSection title="Idle threads">
      <SettingsRow
        title="Move idle threads out of Present"
        description="In Ìtútù, Present threads with no activity for the timeout move automatically. Threads that are working, waiting for you, or have queued messages never move. Turning this on or changing it starts a full new wait."
        searchTerms={["itutu", "idle", "present", "done", "later", "cleanup", "automatic"]}
        control={
          <Switch
            tone="success"
            checked={enabled}
            disabled={saving}
            onCheckedChange={(checked) => void save({ itutuIdleCleanupEnabled: checked })}
            aria-label="Move idle threads out of Present"
          />
        }
      />
      <SettingsRow
        title="Idle timeout"
        description="Minutes without activity before a Present thread moves."
        status={`Minimum ${ITUTU_IDLE_TIMEOUT_MIN_MINUTES} minute, maximum ${ITUTU_IDLE_TIMEOUT_MAX_MINUTES / (24 * 60)} days.`}
        resetAction={
          timeoutMinutes !== DEFAULT_ITUTU_IDLE_TIMEOUT_MINUTES ? (
            <SettingResetButton
              label="idle timeout"
              onClick={() =>
                void save({ itutuIdleTimeoutMinutes: DEFAULT_ITUTU_IDLE_TIMEOUT_MINUTES })
              }
            />
          ) : null
        }
        control={
          <div className="w-full sm:w-[116px]">
            <Input
              type="number"
              min={ITUTU_IDLE_TIMEOUT_MIN_MINUTES}
              max={ITUTU_IDLE_TIMEOUT_MAX_MINUTES}
              step={1}
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitTimeout}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              aria-label="Idle timeout in minutes"
            />
          </div>
        }
      />
      <SettingsRow
        title="Move idle threads to"
        description="Done only organizes the thread; it does not mean the work finished."
        control={
          <Select
            value={destination}
            disabled={saving}
            onValueChange={(value) => {
              if (value === "done" || value === "later") {
                void save({ itutuIdleDestination: value satisfies ItutuIdleDestination });
              }
            }}
          >
            <SelectTrigger variant="muted-outline" className="w-full" aria-label="Idle destination">
              <SelectValue>{ITUTU_IDLE_DESTINATION_LABELS[destination]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(["done", "later"] as const).map((value) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {ITUTU_IDLE_DESTINATION_LABELS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
