import {
  TERMINAL_FAST_SCROLL_SENSITIVITY,
  TERMINAL_SCROLL_SENSITIVITY,
  TERMINAL_TUI_SCROLL_SENSITIVITY,
  TerminalLigatures,
} from "@bigbud/contracts/core/settings.terminal.ts";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { Schema } from "effect";
import { useEffect, useState } from "react";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

type ScrollKey =
  | "terminalScrollSensitivity"
  | "terminalFastScrollSensitivity"
  | "terminalTuiScrollSensitivity";

const SCROLL_ROWS: ReadonlyArray<{
  key: ScrollKey;
  title: string;
  description: string;
  bounds: { readonly min: number; readonly max: number };
  step: number;
  integer: boolean;
}> = [
  {
    key: "terminalScrollSensitivity",
    title: "Terminal scroll speed",
    description: "Scrollback distance per wheel or trackpad step. Applies immediately.",
    bounds: TERMINAL_SCROLL_SENSITIVITY,
    step: 0.05,
    integer: false,
  },
  {
    key: "terminalFastScrollSensitivity",
    title: "Terminal fast scroll speed",
    description: "Multiplier while holding Alt (Option on macOS) during scrolling.",
    bounds: TERMINAL_FAST_SCROLL_SENSITIVITY,
    step: 1,
    integer: false,
  },
  {
    key: "terminalTuiScrollSensitivity",
    title: "Full-screen app scroll speed",
    description:
      "Scroll events sent per resolved row to apps that track the mouse (vim, less, htop, agent TUIs).",
    bounds: TERMINAL_TUI_SCROLL_SENSITIVITY,
    step: 1,
    integer: true,
  },
];

const LIGATURE_LABELS: Record<TerminalLigatures, string> = {
  auto: "Auto (ligature fonts)",
  on: "On",
  off: "Off",
};

function ScrollSpeedRow({ row }: { row: (typeof SCROLL_ROWS)[number] }) {
  const value = useSettings((settings) => settings[row.key]);
  const { updateSettings } = useUpdateSettings();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Number(draft);
    const valid =
      draft.trim() !== "" &&
      Number.isFinite(next) &&
      next >= row.bounds.min &&
      next <= row.bounds.max &&
      (!row.integer || Number.isInteger(next));
    if (valid && next !== value) updateSettings({ [row.key]: next });
    else setDraft(String(value));
  };
  const defaultValue = DEFAULT_UNIFIED_SETTINGS[row.key];
  return (
    <SettingsRow
      title={row.title}
      description={row.description}
      status={`Between ${row.bounds.min} and ${row.bounds.max}.`}
      resetAction={
        value !== defaultValue ? (
          <SettingResetButton
            label={row.title.toLowerCase()}
            onClick={() => updateSettings({ [row.key]: defaultValue })}
          />
        ) : null
      }
      control={
        <div className="w-full sm:w-[116px]">
          <Input
            type="number"
            min={row.bounds.min}
            max={row.bounds.max}
            step={row.step}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            aria-label={row.title}
          />
        </div>
      }
    />
  );
}

/** Scrolling and xterm addon preferences; every change applies to open terminals live. */
export function TerminalInteractionSettings() {
  const ligatures = useSettings((settings) => settings.terminalLigatures);
  const inlineImages = useSettings((settings) => settings.terminalInlineImages);
  const { updateSettings } = useUpdateSettings();
  return (
    <>
      {SCROLL_ROWS.map((row) => (
        <ScrollSpeedRow key={row.key} row={row} />
      ))}
      <SettingsRow
        title="Terminal ligatures"
        description="Auto enables programming ligatures for fonts known to ship them, such as JetBrains Mono and Fira Code."
        resetAction={
          ligatures !== DEFAULT_UNIFIED_SETTINGS.terminalLigatures ? (
            <SettingResetButton
              label="terminal ligatures"
              onClick={() =>
                updateSettings({ terminalLigatures: DEFAULT_UNIFIED_SETTINGS.terminalLigatures })
              }
            />
          ) : null
        }
        control={
          <Select
            value={ligatures}
            onValueChange={(value) => {
              if (Schema.is(TerminalLigatures)(value)) updateSettings({ terminalLigatures: value });
            }}
          >
            <SelectTrigger
              aria-label="Terminal ligatures"
              variant="muted-outline"
              className="w-full sm:w-48"
            >
              <SelectValue>{LIGATURE_LABELS[ligatures]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(["auto", "on", "off"] as const).map((value) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {LIGATURE_LABELS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Terminal inline images"
        description="Render Sixel, iTerm2 and Kitty images printed by terminal programs. Each image sequence is capped at 8 MB."
        control={
          <Switch
            tone="success"
            checked={inlineImages}
            onCheckedChange={(checked) =>
              updateSettings({ terminalInlineImages: Boolean(checked) })
            }
            aria-label="Terminal inline images"
          />
        }
      />
    </>
  );
}
