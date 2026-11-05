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
import {
  formatLimitBound,
  formatLimitMinutes,
  resolveLimitCommit,
} from "./ComputerUseAccessSettingsSection.limits.logic";

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
  const [draft, setDraft] = useState(formatLimitMinutes(valueMs));

  useEffect(() => {
    setDraft(formatLimitMinutes(valueMs));
  }, [valueMs]);

  const commit = useCallback(() => {
    const next = resolveLimitCommit({ draft, valueMs, minMs, maxMs });
    if (next.kind === "commit") {
      setDraft(formatLimitMinutes(next.valueMs));
      onCommit(next.valueMs);
      return;
    }
    setDraft(formatLimitMinutes(valueMs));
  }, [draft, maxMs, minMs, onCommit, valueMs]);

  return (
    <SettingsRow
      title={title}
      description={description}
      status={`Minimum ${formatLimitBound(minMs)}, maximum ${formatLimitBound(maxMs)}.`}
      resetAction={
        valueMs !== defaultValueMs ? (
          <SettingResetButton label={label} onClick={() => onCommit(defaultValueMs)} />
        ) : null
      }
      control={
        <div className="w-full sm:w-[116px]">
          <Input
            type="number"
            min={minMs / 60_000}
            max={maxMs / 60_000}
            step="any"
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
