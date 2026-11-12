import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { TerminalShellProfileInventory } from "@bigbud/contracts/workspace/terminal.shellProfiles.ts";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Settings2 } from "lucide-react";
import { readNativeApi } from "../../rpc/nativeApi";
import { readTerminalLaunch, subscribeTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { sameShellHost, type TerminalProfileLaunch } from "../../lib/terminalProfileLaunch";
import { useSearchStore } from "../../stores/ui/search.store";
import { useTerminalLifecycle } from "../../stores/terminal/terminalLifecycle.store";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { createTerminalProfileInventoryLoader } from "./TerminalProfilePicker.inventory";
import { replaceTerminalProfile } from "./TerminalProfilePicker.restart";
import { toastManager } from "../ui/toast.manager";

interface Props {
  threadId: ThreadId;
  terminalId: string;
  onNewTerminal: (profile?: TerminalProfileLaunch) => void;
  onRename?: (() => void) | undefined;
  findShortcutLabel?: string | undefined;
}

/** The key fences all menu state, requests and confirmations when the active pane changes. */
export function TerminalProfilePicker(props: Props) {
  const launch = useSyncExternalStore(
    subscribeTerminalLaunch,
    () => readTerminalLaunch(props.threadId, props.terminalId),
    () => undefined,
  );
  return (
    <PaneProfilePicker
      key={JSON.stringify([props.threadId, props.terminalId, launch?.runtimeGeneration])}
      {...props}
    />
  );
}

function PaneProfilePicker({
  threadId,
  terminalId,
  onNewTerminal,
  onRename,
  findShortcutLabel,
}: Props) {
  const launch = useSyncExternalStore(
    subscribeTerminalLaunch,
    () => readTerminalLaunch(threadId, terminalId),
    () => undefined,
  );
  const lifecycle = useTerminalLifecycle(threadId, terminalId);
  const [state, setState] = useState<{
    inventory?: TerminalShellProfileInventory;
    error?: string;
    loading: boolean;
  }>({ loading: false });
  const [actionError, setActionError] = useState<string>();
  const mounted = useRef(true);
  const loader = useMemo(() => createTerminalProfileInventoryLoader(readNativeApi, setState), []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loader.invalidate();
    };
  }, [loader]);
  const actual = launch?.shellLaunchIdentity;
  const inventory = state.inventory;
  const exactEnabled =
    inventory?.exactProfileLaunchesEnabled === true &&
    !!launch?.runtimeGeneration &&
    inventory.runtimeGeneration === launch.runtimeGeneration;
  const hostMatches = !actual || !inventory || sameShellHost(actual.host, inventory.host);
  const actualProfile = hostMatches
    ? inventory?.profiles.find((profile) => profile.profileId === actual?.profileId)
    : undefined;
  const label = actual
    ? (actualProfile?.displayName ?? actual.kind)
    : launch?.shellUnconfirmedLaunch
      ? "Shell unconfirmed"
      : "Shell unknown";
  const error =
    actionError ??
    state.error ??
    (!hostMatches ? "The terminal host changed. Refresh its profile inventory." : undefined);
  const perform = async (profileId: string, replace: boolean) => {
    if (
      !mounted.current ||
      !inventory ||
      !exactEnabled ||
      !hostMatches ||
      lifecycle ||
      readTerminalLaunch(threadId, terminalId)?.runtimeGeneration !== launch?.runtimeGeneration
    )
      return;
    const profile: TerminalProfileLaunch = {
      host: inventory.host,
      shellSelection: { kind: "profile", profileId },
      source: { terminalId, runtimeGeneration: launch?.runtimeGeneration },
    };
    try {
      setActionError(undefined);
      if (replace) {
        if (!launch?.runtimeGeneration)
          throw new Error("Refresh the terminal view before replacing its shell.");
        await replaceTerminalProfile(threadId, terminalId, {
          profile,
          expectedGeneration: launch.runtimeGeneration,
          isCurrent: () => mounted.current,
        });
      } else onNewTerminal(profile);
    } catch (cause) {
      if (mounted.current) {
        const message = cause instanceof Error ? cause.message : "Shell launch failed.";
        setActionError(message);
        toastManager.add({
          type: "error",
          title: "Terminal shell launch failed",
          description: message,
        });
      }
    }
  };
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) {
          setActionError(undefined);
          void loader.load(threadId, terminalId);
        }
      }}
    >
      <MenuTrigger
        aria-label="Terminal actions"
        title="Terminal actions"
        className="inline-flex items-center p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Settings2 aria-hidden="true" className="size-3.25" />
      </MenuTrigger>
      <MenuPopup align="end" className="max-w-80">
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {label}
          {actual ? ` · ${actual.host.kind === "local" ? "Local" : actual.host.kind}` : ""}
        </p>
        {launch?.shellUnconfirmedLaunch && (
          <p className="px-2 py-1 text-xs text-amber-600">
            Requested: {launch.shellUnconfirmedLaunch.requestedProfile.kind}. Actual shell has not
            been confirmed.
          </p>
        )}
        <MenuItem
          aria-label="Search"
          onClick={() =>
            useSearchStore.getState().requestTerminalFind({
              threadId,
              terminalId,
              query: "",
              lineText: "",
            })
          }
        >
          Search
          {findShortcutLabel && <MenuShortcut>{findShortcutLabel}</MenuShortcut>}
        </MenuItem>
        <MenuItem onClick={onRename} disabled={!onRename}>
          Rename
        </MenuItem>
        <MenuItem onClick={() => void loader.load(threadId, terminalId)} disabled={state.loading}>
          Refresh
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onClick={() =>
            onNewTerminal({
              shellSelection: { kind: "legacy-auto" },
              source: { terminalId, runtimeGeneration: launch?.runtimeGeneration },
            })
          }
        >
          Open Automatic terminal
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={!inventory || !exactEnabled || !hostMatches || !!lifecycle}>
            New terminal
          </MenuSubTrigger>
          <MenuSubPopup>
            {inventory?.profiles.map((profile) => (
              <MenuItem
                key={profile.profileId}
                disabled={profile.availability !== "available"}
                onClick={() => void perform(profile.profileId, false)}
              >
                {profile.displayName}
                {profile.availability !== "available" ? " (unavailable)" : ""}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger
            disabled={
              !inventory ||
              !exactEnabled ||
              !hostMatches ||
              !!lifecycle ||
              !launch?.runtimeGeneration
            }
          >
            Change shell
          </MenuSubTrigger>
          <MenuSubPopup>
            {inventory?.profiles.map((profile) => (
              <MenuItem
                key={profile.profileId}
                disabled={profile.availability !== "available"}
                onClick={() => void perform(profile.profileId, true)}
              >
                {profile.displayName}
                {profile.availability !== "available" ? " (unavailable)" : ""}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
        {inventory && !exactEnabled && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            Exact shell selection is unavailable for this session. Open Automatic terminal uses the
            same target and folder in a new pane.
          </p>
        )}
        {state.loading && (
          <p className="px-2 py-1 text-xs text-muted-foreground">Loading this host's profiles…</p>
        )}
        {inventory?.profiles.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            No profiles are available on this terminal's host.
          </p>
        )}
        {error && (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            {error}
          </p>
        )}
      </MenuPopup>
    </Menu>
  );
}
