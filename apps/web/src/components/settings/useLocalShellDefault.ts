import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalShellProfileInventory } from "@bigbud/contracts/workspace/terminal.shellProfiles.ts";
import type { ShellSelection } from "@bigbud/contracts/workspace/terminalShell.ts";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { persistServerSettings } from "../../hooks/useSettings";

export function useLocalShellDefault() {
  const [inventory, setInventory] = useState<TerminalShellProfileInventory>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const api = ensureNativeApi().terminal.shellProfiles;
      if (!api) throw new Error("Local shell discovery requires a newer server.");
      const result = await api({ scope: "local-settings" });
      if (result.host.kind !== "local" || result.host.hostId !== "local")
        throw new Error("The server returned a different execution host.");
      if (generation.current === current) setInventory(result);
    } catch (cause) {
      if (generation.current === current) {
        setInventory(undefined);
        setError(cause instanceof Error ? cause.message : "Local shell discovery failed.");
      }
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, []);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    void refresh();
    return invalidate;
  }, [refresh, invalidate]);
  const save = async (selection: ShellSelection) => {
    if (pending.current || loading || inventory?.localDefaultsEnabled !== true) return;
    pending.current = true;
    setSaving(true);
    setError(undefined);
    const current = generation.current;
    try {
      await persistServerSettings({ terminalShells: { localDefault: selection } });
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : "The default shell could not be saved.");
    } finally {
      pending.current = false;
      if (current === generation.current) setSaving(false);
    }
  };
  return { inventory, loading, saving, error, refresh, save };
}
