import {
  COMPUTER_USE_ACTION_TIMEOUT_MS_MAX,
  COMPUTER_USE_ACTION_TIMEOUT_MS_MIN,
  COMPUTER_USE_CHECK_IN_INTERVAL_MS_MAX,
  COMPUTER_USE_CHECK_IN_INTERVAL_MS_MIN,
  DEFAULT_UNIFIED_SETTINGS,
  type UnifiedSettings,
} from "@bigbud/contracts/settings";
import { useCallback, useEffect, useState } from "react";
import { useUpdateSettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

const MS_PER_MINUTE = 60_000;

function toMinutes(ms: number): number {
  return Math.round(ms / MS_PER_MINUTE);
}

function clampMinutes(value: number, minMs: number, maxMs: number): number {
  return Math.min(toMinutes(maxMs), Math.max(toMinutes(minMs), Math.round(value)));
}

function LimitSettingsRow({
  title,
  description,
  label,
  valueMs,
  defaultValueMs,
  minMs,
  maxMs,
  onCommit,
}: {
  title: string;
  description: string;
  label: string;
  valueMs: number;
  defaultValueMs: number;
  minMs: number;
  maxMs: number;
  onCommit: (valueMs: number) => void;
}) {
  const [draft, setDraft] = useState(String(toMinutes(valueMs)));

  useEffect(() => {
    setDraft(String(toMinutes(valueMs)));
  }, [valueMs]);

  const commit = useCallback(() => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(toMinutes(valueMs)));
      return;
    }
    const nextMinutes = clampMinutes(parsed, minMs, maxMs);
    const nextValueMs = nextMinutes * MS_PER_MINUTE;
    setDraft(String(nextMinutes));
    if (nextValueMs !== valueMs) {
      onCommit(nextValueMs);
    }
  }, [draft, maxMs, minMs, onCommit, valueMs]);

  return (
    <SettingsRow
      title={title}
      description={description}
      status={`Minimum ${toMinutes(minMs)} minute, maximum ${toMinutes(maxMs)} minutes.`}
      resetAction={
        valueMs !== defaultValueMs ? (
          <SettingResetButton label={label} onClick={() => onCommit(defaultValueMs)} />
        ) : null
      }
      control={
        <div className="w-full sm:w-[116px]">
          <Input
            type="number"
            min={toMinutes(minMs)}
            max={toMinutes(maxMs)}
            step={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            aria-label={`${label} in minutes`}
          />
        </div>
      }
    />
  );
}

export function ComputerUseLimitSettingsRows({
  settings,
}: {
  settings: Pick<UnifiedSettings, "computerUseCheckInIntervalMs" | "computerUseActionTimeoutMs">;
}) {
  const { updateSettings } = useUpdateSettings();

  return (
    <>
      <LimitSettingsRow
        title="Check-in interval"
        description="Require agents to ask before continuing after this much computer-use activity."
        label="computer use check-in interval"
        valueMs={settings.computerUseCheckInIntervalMs}
        defaultValueMs={DEFAULT_UNIFIED_SETTINGS.computerUseCheckInIntervalMs}
        minMs={COMPUTER_USE_CHECK_IN_INTERVAL_MS_MIN}
        maxMs={COMPUTER_USE_CHECK_IN_INTERVAL_MS_MAX}
        onCommit={(computerUseCheckInIntervalMs) =>
          updateSettings({ computerUseCheckInIntervalMs })
        }
      />
      <LimitSettingsRow
        title="Action timeout"
        description="Stop a single computer-use action if the runtime does not finish in time."
        label="computer use action timeout"
        valueMs={settings.computerUseActionTimeoutMs}
        defaultValueMs={DEFAULT_UNIFIED_SETTINGS.computerUseActionTimeoutMs}
        minMs={COMPUTER_USE_ACTION_TIMEOUT_MS_MIN}
        maxMs={COMPUTER_USE_ACTION_TIMEOUT_MS_MAX}
        onCommit={(computerUseActionTimeoutMs) => updateSettings({ computerUseActionTimeoutMs })}
      />
    </>
  );
}
