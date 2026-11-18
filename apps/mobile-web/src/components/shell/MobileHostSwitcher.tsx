import { useEffect, useRef, useState } from "react";
import { createMobileHostFocusReturn } from "./MobileHostSwitcher.focus";
import { MobileHostDestination } from "./MobileHostDestination";
import { ChevronDownIcon } from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import { useMobileHosts } from "../../context/MobileHostsContext";
import { useMobileRpcClient } from "../../context/MobileRpcContext";
import {
  allowsMobileCredentialOrigin,
  mobileHostNavigationURL,
} from "../../logic/mobileDeploymentPolicy";
import type { MobileHostDirectoryEntry } from "../../lib/mobileHostDirectory";

const ITEM =
  "flex min-h-11 max-w-[calc(100vw-3rem)] items-center rounded-lg px-3 py-2 text-sm outline-none data-highlighted:bg-accent";

export function MobileHostSwitcher() {
  const context = useMobileHosts();
  const trigger = useRef<HTMLButtonElement>(null);
  const returnAfterEscape = useRef(false);
  const [focusReturn] = useState(() =>
    createMobileHostFocusReturn({
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
      canRestore: () => document.activeElement === document.body && !!trigger.current?.isConnected,
      restore: () => trigger.current?.focus(),
    }),
  );
  useEffect(() => () => focusReturn.cancel(), [focusReturn]);
  const { connection, recoveryState } = useMobileRpcClient();
  if (!context) return null;
  const { hosts, admission, legacySession, directory } = context;
  const local = hosts.value.collection.entries.filter((entry) =>
    allowsMobileCredentialOrigin(hosts.policy, entry.backendOrigin),
  );
  const links = new Map<string, MobileHostDirectoryEntry>();
  if (directory.state.ok)
    for (const entry of directory.state.entries) links.set(entry.backendOrigin, entry);
  for (const entry of hosts.value.collection.entries) {
    if (!allowsMobileCredentialOrigin(hosts.policy, entry.backendOrigin))
      links.set(entry.backendOrigin, {
        backendOrigin: entry.backendOrigin,
        authorityId: entry.pin.authority.authorityId,
      });
  }
  for (const entry of local) links.delete(entry.backendOrigin);
  if (!local.length && !links.size) return null;
  const origin =
    hosts.selected?.backendOrigin ??
    (hosts.value.legacySelected === false ? null : legacySession?.backendBaseUrl);
  const label = origin ? new URL(origin).host : "Choose host";
  const status =
    hosts.selected && admission.status !== "ready"
      ? admission.status === "checking"
        ? "Verifying identity"
        : "Connection blocked"
      : !origin
        ? "No host selected"
        : connection.transport === "exhausted" || connection.authorization !== "unknown"
          ? "Connection failed"
          : connection.transport === "open"
            ? recoveryState.freshness === "current"
              ? "Connected and current"
              : "Refreshing chats"
            : "Reconnecting";
  const tone =
    status === "Connected and current"
      ? "bg-emerald-500"
      : status === "Connection blocked"
        ? "bg-amber-500"
        : status === "Connection failed"
          ? "bg-destructive"
          : status === "No host selected"
            ? "bg-muted-foreground"
            : "bg-blue-500";
  return (
    <Menu.Root
      onOpenChange={(open, details) => {
        // The primitive can emit a trailing hover-close after Escape. Preserve
        // that keyboard dismissal until completion rather than losing its target.
        if (!open && details.reason === "trigger-hover") return;
        focusReturn.cancel();
        returnAfterEscape.current = !open && details.reason === "escape-key";
      }}
      onOpenChangeComplete={(open) => {
        // Run after the primitive removes its modal/inert ownership. Respect any
        // deliberate focus change between dismissal and the next frame.
        if (!open && returnAfterEscape.current) focusReturn.schedule();
        if (!open) returnAfterEscape.current = false;
      }}
    >
      <Menu.Trigger
        ref={trigger}
        aria-label={`Selected backend ${origin ?? "none"}. ${status}. Change host`}
        className="inline-flex min-h-11 min-w-11 max-w-28 items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${tone}`} />
        <span className="truncate">{label}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} collisionPadding={8} className="z-50">
          <Menu.Popup
            finalFocus={trigger}
            className="max-h-[min(50dvh,var(--available-height))] w-[min(20rem,calc(100vw-2rem))] overflow-auto rounded-xl border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none"
          >
            {legacySession ? (
              <Menu.Item className={ITEM} onClick={() => context.selectHost(null, true)}>
                <MobileHostDestination
                  origin={legacySession.backendBaseUrl}
                  prefix="Previous connection: "
                />
              </Menu.Item>
            ) : null}
            {local.map((host) => (
              <Menu.Item
                className={ITEM}
                key={host.pin.authority.authorityId}
                onClick={() => context.selectHost(host.pin.authority.authorityId, false)}
              >
                <MobileHostDestination
                  origin={host.backendOrigin}
                  detail={`Authority: ${host.pin.authority.authorityId.slice(0, 8)} · ${host.session.scope}`}
                />
              </Menu.Item>
            ))}
            {[...links.values()].map((entry) => (
              <Menu.Item
                key={entry.backendOrigin}
                className={ITEM}
                render={
                  <a
                    href={mobileHostNavigationURL(entry.backendOrigin) ?? undefined}
                    referrerPolicy="no-referrer"
                  />
                }
              >
                <MobileHostDestination
                  origin={entry.backendOrigin}
                  label={entry.displayName}
                  prefix="Open "
                  detail="Separate host · credentials stay there"
                />
              </Menu.Item>
            ))}
            {!legacySession && hosts.selected ? (
              <Menu.Item className={ITEM} onClick={() => context.selectHost(null, false)}>
                Leave selected host
              </Menu.Item>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
