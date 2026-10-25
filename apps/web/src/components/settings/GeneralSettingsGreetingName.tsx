import {
  GREETING_NAME_MAX_LENGTH,
  GreetingName,
} from "@bigbud/contracts/core/settings.greeting.ts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useRef, useState } from "react";

import { useSettings } from "../../hooks/useSettings";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { applySettingsUpdated } from "../../rpc/serverState";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

export function GeneralSettingsGreetingName() {
  const name = useSettings((settings) => settings.greetingName);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const previousNameRef = useRef(name);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const previous = previousNameRef.current;
    previousNameRef.current = name;
    // Shared-instance updates should not discard an edit that is still in progress.
    setDraft((current) => (current === previous ? name : current));
  }, [name]);

  const save = useCallback(
    async (value: string) => {
      if (savingRef.current) return;
      const trimmed = value.trim();
      setDraft(trimmed);
      if (trimmed === name) return;
      savingRef.current = true;
      setSaving(true);
      try {
        const greetingName = Schema.decodeSync(GreetingName)(trimmed);
        const settings = await ensureNativeApi().server.updateSettings({ greetingName });
        // Only acknowledge a persisted value, never an optimistic nickname.
        applySettingsUpdated(settings);
        if (mountedRef.current) setDraft(settings.greetingName);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to save greeting name",
          description:
            error instanceof Error ? error.message : "Reconnect and try saving your name again.",
        });
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    },
    [name],
  );

  return (
    <SettingsRow
      title="What should bigbud call you?"
      description="An optional name or nickname for new-chat greetings. Shared across this bigbud instance; never sent to AI providers."
      searchTerms={["name", "nickname", "greeting"]}
      resetAction={
        name && draft.trim() === name && !saving ? (
          <SettingResetButton label="greeting name" onClick={() => void save("")} />
        ) : null
      }
      control={
        <Input
          aria-label="What should bigbud call you?"
          className="w-full sm:w-56"
          placeholder="Name or nickname"
          maxLength={GREETING_NAME_MAX_LENGTH}
          value={draft}
          disabled={saving}
          aria-busy={saving}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void save(draft);
            }
          }}
        />
      }
    />
  );
}
