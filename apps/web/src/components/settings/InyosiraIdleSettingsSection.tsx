import {
  DEFAULT_INYOSIRA_IDLE_TIMEOUT_MINUTES,
  DEFAULT_INYOSIRA_OLDER_THREADS_DAYS,
  type InyosiraIdleDestination,
  type ServerSettingsPatch,
} from "@bigbud/contracts/settings";
import { useOrganizationStatus } from "../../hooks/useOrganizationStatus";
import { organizationPausedCopy } from "../../lib/organizationStatusCopy";
import { useEffect, useState } from "react";

import { persistServerSettings, useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  IDLE_TIMEOUT_MINUTES_BOUNDS,
  INYOSIRA_IDLE_DESTINATION_LABELS,
  OLDER_THREADS_DAYS_BOUNDS,
  resolveWholeNumberDraft,
  type WholeNumberBounds,
} from "./InyosiraIdleSettingsSection.logic";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

/** A whole-number field that saves on blur or Enter and restores invalid drafts. */
export function WholeNumberSettingInput(props: {
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
 * Inyosira idle cleanup, in two steps. The server owns the policy, so a change shows only once it is
 * saved. Turning a step on or changing it gives every thread a full new wait for that step.
 */
export function InyosiraIdleSettingsSection() {
  const status = useOrganizationStatus();
  const pausedCopy = organizationPausedCopy(status);
  const targetEnabled = useSettings((settings) => settings.inyosiraPresentTargetEnabled);
  const target = useSettings((settings) => settings.inyosiraPresentTarget);
  const grace = useSettings((settings) => settings.inyosiraGraceMinutes);
  const enabled = useSettings((settings) => settings.inyosiraIdleCleanupEnabled);
  const timeoutMinutes = useSettings((settings) => settings.inyosiraIdleTimeoutMinutes);
  const destination = useSettings((settings) => settings.inyosiraIdleDestination);
  const olderEnabled = useSettings((settings) => settings.inyosiraOlderThreadsEnabled);
  const olderDays = useSettings((settings) => settings.inyosiraOlderThreadsDays);
  const [saving, setSaving] = useState(false);

  const save = async (patch: ServerSettingsPatch) => {
    setSaving(true);
    try {
      await persistServerSettings(patch);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't save Inyosira settings",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div id="inyosira">
      <SettingsSection title="Inyosira">
        {pausedCopy ? (
          <p role="status" className="text-xs text-muted-foreground">
            {pausedCopy}
          </p>
        ) : null}
        <SettingsRow
          title="Keep Present focused"
          description="A soft target across all projects on this server. Working threads can stay above it indefinitely; eligible inactive threads move to Later after their grace period. This can act sooner than the separate idle timeout."
          control={
            <Switch
              tone="success"
              checked={targetEnabled ?? status?.installation === "new"}
              disabled={saving || !status}
              aria-label="Keep Present focused"
              onCheckedChange={(checked) =>
                void save({
                  inyosiraPresentTargetEnabled: checked,
                  inyosiraIntroductionDismissed: true,
                })
              }
            />
          }
        />
        <SettingsRow
          title="Present target"
          description="The number of threads to aim for, rather than a limit on running work."
          control={
            <WholeNumberSettingInput
              value={target}
              bounds={{ min: 1, max: 100000 }}
              disabled={saving}
              ariaLabel="Present target"
              onCommit={(value) => void save({ inyosiraPresentTarget: value })}
            />
          }
        />
        <SettingsRow
          title="Protection after activity"
          description="Minutes before automatic cleanup can move a thread after work finishes, you return it to Present, or you Undo a move. Applies even with idle cleanup off. Enabling or changing the target grants this wait too."
          control={
            <WholeNumberSettingInput
              value={grace}
              bounds={{ min: 2, max: 10 }}
              disabled={saving}
              ariaLabel="Inyosira grace in minutes"
              onCommit={(value) => void save({ inyosiraGraceMinutes: value })}
            />
          }
        />
        <SettingsRow
          title="Move idle threads out of Present"
          description="In Inyosira, Present threads with no activity for the timeout move automatically. Threads that are working, waiting for you, or have queued messages never move. Turning this on or changing it starts a full new wait."
          searchTerms={["inyosira", "idle", "present", "done", "later", "cleanup", "automatic"]}
          control={
            <Switch
              tone="success"
              checked={enabled}
              disabled={saving}
              onCheckedChange={(checked) => void save({ inyosiraIdleCleanupEnabled: checked })}
              aria-label="Move idle threads out of Present"
            />
          }
        />
        <SettingsRow
          title="Idle timeout"
          description="Minutes without activity before a Present thread moves."
          status={`Minimum ${IDLE_TIMEOUT_MINUTES_BOUNDS.min} minutes, maximum 1 day (${IDLE_TIMEOUT_MINUTES_BOUNDS.max} minutes).`}
          resetAction={
            timeoutMinutes !== DEFAULT_INYOSIRA_IDLE_TIMEOUT_MINUTES ? (
              <SettingResetButton
                label="idle timeout"
                onClick={() =>
                  void save({ inyosiraIdleTimeoutMinutes: DEFAULT_INYOSIRA_IDLE_TIMEOUT_MINUTES })
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
              onCommit={(value) => void save({ inyosiraIdleTimeoutMinutes: value })}
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
                  void save({ inyosiraIdleDestination: value satisfies InyosiraIdleDestination });
                }
              }}
            >
              <SelectTrigger
                variant="muted-outline"
                className="w-full"
                aria-label="Idle destination"
              >
                <SelectValue>{INYOSIRA_IDLE_DESTINATION_LABELS[destination]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(["later", "done"] as const).map((value) => (
                  <SelectItem hideIndicator key={value} value={value}>
                    {INYOSIRA_IDLE_DESTINATION_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Move older threads to Done"
          description="Present or Later threads with no activity for this many days move to Done. Snoozed threads wait for their reminder instead, and threads that are working or waiting for you never move."
          searchTerms={[
            "inyosira",
            "older",
            "old",
            "stale",
            "later",
            "done",
            "cleanup",
            "automatic",
          ]}
          control={
            <Switch
              tone="success"
              checked={olderEnabled}
              disabled={saving}
              onCheckedChange={(checked) => void save({ inyosiraOlderThreadsEnabled: checked })}
              aria-label="Move older threads to Done"
            />
          }
        />
        <SettingsRow
          title="Older than"
          description="Days without activity before a Present or Later thread moves to Done."
          status={`Minimum ${OLDER_THREADS_DAYS_BOUNDS.min} day, maximum ${OLDER_THREADS_DAYS_BOUNDS.max} days.`}
          resetAction={
            olderDays !== DEFAULT_INYOSIRA_OLDER_THREADS_DAYS ? (
              <SettingResetButton
                label="older threads age"
                onClick={() =>
                  void save({ inyosiraOlderThreadsDays: DEFAULT_INYOSIRA_OLDER_THREADS_DAYS })
                }
              />
            ) : null
          }
          control={
            <WholeNumberSettingInput
              value={olderDays}
              bounds={OLDER_THREADS_DAYS_BOUNDS}
              disabled={saving}
              ariaLabel="Older threads age in days"
              onCommit={(value) => void save({ inyosiraOlderThreadsDays: value })}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
