import {
  DEFAULT_ITUTU_IDLE_TIMEOUT_MINUTES,
  DEFAULT_ITUTU_OLDER_THREADS_DAYS,
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
  IDLE_TIMEOUT_MINUTES_BOUNDS,
  ITUTU_IDLE_DESTINATION_LABELS,
  OLDER_THREADS_DAYS_BOUNDS,
  resolveWholeNumberDraft,
  type WholeNumberBounds,
} from "./ItutuIdleSettingsSection.logic";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

/** A whole-number field that saves on blur or Enter and restores invalid drafts. */
function WholeNumberSettingInput(props: {
  readonly value: number;
  readonly bounds: WholeNumberBounds;
  readonly disabled: boolean;
  readonly ariaLabel: string;
  readonly onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.value));

  useEffect(() => setDraft(String(props.value)), [props.value]);

  const commit = () => {
    const next = resolveWholeNumberDraft(draft, props.value, props.bounds);
    if (next === null) setDraft(String(props.value));
    else props.onCommit(next);
  };

  return (
    <div className="w-full sm:w-[116px]">
      <Input
        type="number"
        min={props.bounds.min}
        max={props.bounds.max}
        step={1}
        value={draft}
        disabled={props.disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        aria-label={props.ariaLabel}
      />
    </div>
  );
}

/**
 * Ìtútù idle cleanup, in two steps. The server owns the policy, so a change shows only once it is
 * saved. Turning a step on or changing it gives every thread a full new wait for that step.
 */
export function ItutuIdleSettingsSection() {
  const enabled = useSettings((settings) => settings.itutuIdleCleanupEnabled);
  const timeoutMinutes = useSettings((settings) => settings.itutuIdleTimeoutMinutes);
  const destination = useSettings((settings) => settings.itutuIdleDestination);
  const olderEnabled = useSettings((settings) => settings.itutuOlderThreadsEnabled);
  const olderDays = useSettings((settings) => settings.itutuOlderThreadsDays);
  const [saving, setSaving] = useState(false);

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
        status={`Minimum ${IDLE_TIMEOUT_MINUTES_BOUNDS.min} minutes, maximum 1 day (${IDLE_TIMEOUT_MINUTES_BOUNDS.max} minutes).`}
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
          <WholeNumberSettingInput
            value={timeoutMinutes}
            bounds={IDLE_TIMEOUT_MINUTES_BOUNDS}
            disabled={saving}
            ariaLabel="Idle timeout in minutes"
            onCommit={(value) => void save({ itutuIdleTimeoutMinutes: value })}
          />
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
              {(["later", "done"] as const).map((value) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {ITUTU_IDLE_DESTINATION_LABELS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Move older threads to Done"
        description="Present or Later threads with no activity for this many days move to Done. Snoozed threads wait for their reminder instead, and threads that are working or waiting for you never move."
        searchTerms={["itutu", "older", "old", "stale", "later", "done", "cleanup", "automatic"]}
        control={
          <Switch
            tone="success"
            checked={olderEnabled}
            disabled={saving}
            onCheckedChange={(checked) => void save({ itutuOlderThreadsEnabled: checked })}
            aria-label="Move older threads to Done"
          />
        }
      />
      <SettingsRow
        title="Older than"
        description="Days without activity before a Present or Later thread moves to Done."
        status={`Minimum ${OLDER_THREADS_DAYS_BOUNDS.min} day, maximum ${OLDER_THREADS_DAYS_BOUNDS.max} days.`}
        resetAction={
          olderDays !== DEFAULT_ITUTU_OLDER_THREADS_DAYS ? (
            <SettingResetButton
              label="older threads age"
              onClick={() => void save({ itutuOlderThreadsDays: DEFAULT_ITUTU_OLDER_THREADS_DAYS })}
            />
          ) : null
        }
        control={
          <WholeNumberSettingInput
            value={olderDays}
            bounds={OLDER_THREADS_DAYS_BOUNDS}
            disabled={saving}
            ariaLabel="Older threads age in days"
            onCommit={(value) => void save({ itutuOlderThreadsDays: value })}
          />
        }
      />
    </SettingsSection>
  );
}
