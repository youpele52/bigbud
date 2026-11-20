import { GreetingName } from "@bigbud/contracts/core/settings.greeting.ts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useRef, useState } from "react";

import { useSettings } from "../../hooks/useSettings";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { applySettingsUpdated } from "../../rpc/serverState";
import { toastManager } from "../ui/toast";

/** Draft + persisted save for the shared greeting name (Settings → General, welcome tour). */
export function useGreetingNameDraft() {
  const name = useSettings((settings) => settings.greetingName);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
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

  /**
   * Resolves `true` once the value is persisted (or unchanged), `false` when saving failed. A call
   * made while a save is in flight (Enter, then the resulting blur) joins that save.
   */
  const save = useCallback(
    (value: string): Promise<boolean> => {
      if (inFlightRef.current) return inFlightRef.current;
      const trimmed = value.trim();
      setDraft(trimmed);
      if (trimmed === name) return Promise.resolve(true);
      setSaving(true);
      // Starts after `inFlightRef` is set, so a synchronous failure still clears it.
      const request = Promise.resolve().then(async () => {
        try {
          const greetingName = Schema.decodeSync(GreetingName)(trimmed);
          const settings = await ensureNativeApi().server.updateSettings({ greetingName });
          // Only acknowledge a persisted value, never an optimistic nickname.
          applySettingsUpdated(settings);
          if (mountedRef.current) setDraft(settings.greetingName);
          return true;
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Unable to save greeting name",
            description:
              error instanceof Error ? error.message : "Reconnect and try saving your name again.",
          });
          return false;
        } finally {
          inFlightRef.current = null;
          if (mountedRef.current) setSaving(false);
        }
      });
      inFlightRef.current = request;
      return request;
    },
    [name],
  );

  return { name, draft, setDraft, saving, save };
}
