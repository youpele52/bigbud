import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import type { MobileRecoveryState } from "../../logic/mobileRecovery.types";
import type { MobileConnectionState } from "../../logic/mobileConnection.logic";
import type { StoredMobileSession } from "../../lib/mobileSession";
import { sanitizeMobileBackendOrigin } from "./MobileNavigationSheet.logic";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../ui/button";

interface MobileNavigationSettingsProps {
  readonly session: StoredMobileSession | null;
  readonly recoveryState: MobileRecoveryState;
  readonly connection: MobileConnectionState;
  readonly onRetry: () => void;
  readonly onForget: () => void;
}

export function MobileNavigationSettings({
  session,
  recoveryState,
  connection,
  onRetry,
  onForget,
}: MobileNavigationSettingsProps) {
  const { theme, setTheme } = useTheme();
  const [confirmForget, setConfirmForget] = useState(false);
  const origin = session ? sanitizeMobileBackendOrigin(session.backendBaseUrl) : null;
  const expiresAt = session ? new Date(session.expiresAt).toLocaleString() : "Not paired";
  const lastRefresh = recoveryState.lastRefreshedAt ?? recoveryState.lastSynchronizedAt;

  if (confirmForget) {
    return (
      <div className="grid gap-4 px-3 py-2">
        <div className="grid gap-1">
          <h2 className="text-sm font-semibold">Forget this connection?</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Removes this connection and its drafts from this browser. It does not revoke the desktop
            authorization.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            className="min-h-11"
            onClick={() => setConfirmForget(false)}
            size="sm"
            variant="outline"
          >
            Keep connection
          </Button>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-destructive px-3 text-sm text-destructive-foreground"
            onClick={onForget}
            type="button"
          >
            Forget connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-5 px-3 py-2">
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Appearance</h2>
        <label className="grid gap-1 text-xs text-muted-foreground" htmlFor="mobile-theme">
          Theme
          <select
            className="min-h-11 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
            id="mobile-theme"
            onChange={(event) => setTheme(event.target.value as "system" | "light" | "dark")}
            value={theme}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </section>
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Connection</h2>
        <dl className="grid gap-2 text-xs">
          <div>
            <dt className="text-muted-foreground">Backend</dt>
            <dd className="truncate text-foreground">{origin ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd className="text-foreground">
              {connection.transport === "open"
                ? recoveryState.freshness === "current"
                  ? "Connected and current"
                  : "Connected; refreshing chats"
                : connection.authorization === "locally-expired"
                  ? "Session expired"
                  : connection.authorization === "explicitly-rejected"
                    ? "Pairing required"
                    : connection.browserOffline
                      ? "Device offline"
                      : connection.transport === "exhausted"
                        ? "Unable to connect"
                        : "Reconnecting"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last successful refresh</dt>
            <dd className="text-foreground">
              {lastRefresh === null
                ? "None yet"
                : new Date(lastRefresh).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Stored expiry</dt>
            <dd className="text-foreground">{expiresAt}</dd>
          </div>
        </dl>
        <Button className="min-h-11 w-fit" onClick={onRetry} size="sm" variant="outline">
          <RefreshCwIcon className="size-3.5" /> Retry connection
        </Button>
      </section>
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Pairing help</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Open a new pairing link from the desktop app if this connection expires or cannot
          reconnect.
        </p>
      </section>
      <section className="grid gap-2 border-t border-border/70 pt-4">
        <Button
          className="min-h-11 w-fit"
          onClick={() => setConfirmForget(true)}
          size="sm"
          variant="outline"
        >
          Forget this connection
        </Button>
      </section>
    </div>
  );
}
