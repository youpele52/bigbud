import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SmartphoneIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { ensureNativeApi } from "../../rpc/nativeApi";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  normalizeBackendBaseUrl,
  resolveDefaultBackendBaseUrl,
  resolveDefaultMobileWebBaseUrl,
} from "./mobileRemoteControl.urls";

const MOBILE_REMOTE_SESSIONS_QUERY_KEY = ["mobile-remote-sessions"] as const;
const MOBILE_WEB_BASE_URL_STORAGE_KEY = "bigbud:mobile-web:base-url:v1";
const MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY = "bigbud:mobile-remote:backend-url:v1";

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function readStoredValue(key: string, fallback: string): string {
  if (typeof window === "undefined") {
    return fallback;
  }
  const stored = window.localStorage.getItem(key)?.trim();
  return stored && stored.length > 0 ? stored : fallback;
}

function readStoredBackendBaseUrl(): string {
  const fallback = resolveDefaultBackendBaseUrl();
  const stored = readStoredValue(MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY, fallback);
  return normalizeBackendBaseUrl(stored);
}

export function MobileRemoteControlSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const queryClient = useQueryClient();
  const [mobileBaseUrl, setMobileBaseUrl] = useState(() =>
    readStoredValue(MOBILE_WEB_BASE_URL_STORAGE_KEY, resolveDefaultMobileWebBaseUrl()),
  );
  const [backendBaseUrl, setBackendBaseUrl] = useState(readStoredBackendBaseUrl);
  const [pairingLink, setPairingLink] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);

  const sessionsQuery = useQuery({
    queryKey: MOBILE_REMOTE_SESSIONS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listMobileRemoteSessions(),
    staleTime: 5_000,
  });

  const createPairingMutation = useMutation({
    mutationFn: async () => {
      const nextMobileBaseUrl = stripTrailingSlash(mobileBaseUrl.trim());
      const nextBackendBaseUrl = normalizeBackendBaseUrl(backendBaseUrl);
      window.localStorage.setItem(MOBILE_WEB_BASE_URL_STORAGE_KEY, nextMobileBaseUrl);
      window.localStorage.setItem(MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY, nextBackendBaseUrl);
      setBackendBaseUrl(nextBackendBaseUrl);
      return ensureNativeApi().server.createMobileRemotePairing({
        scope: settings.mobileRemoteControl.defaultScope,
        baseUrl: nextMobileBaseUrl,
        backendBaseUrl: nextBackendBaseUrl,
      });
    },
    onSuccess: (pairing) => {
      setPairingError(null);
      setPairingLink(pairing.pairUrl);
    },
    onError: (error) => {
      setPairingLink(null);
      setPairingError(error instanceof Error ? error.message : String(error));
    },
  });

  const revokeSessionMutation = useMutation({
    mutationFn: (sessionId: string) =>
      ensureNativeApi().server.revokeMobileRemoteSession({ sessionId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: MOBILE_REMOTE_SESSIONS_QUERY_KEY });
    },
  });

  const activeSessionCount =
    sessionsQuery.data?.sessions.filter((session) => session.revokedAt === null).length ?? 0;
  const status = useMemo(() => {
    if (!settings.mobileRemoteControl.enabled) {
      return "Disabled. Mobile sessions are rejected until you enable mobile remote control.";
    }
    return `${activeSessionCount} active mobile session${activeSessionCount === 1 ? "" : "s"}.`;
  }, [activeSessionCount, settings.mobileRemoteControl.enabled]);

  return (
    <SettingsSection title="Mobile Remote" icon={<SmartphoneIcon className="size-3" />}>
      <SettingsRow
        title="Enable mobile remote control"
        description="Allow scoped mobile sessions to pair with the desktop server."
        status={status}
        control={
          <Switch
            checked={settings.mobileRemoteControl.enabled}
            onCheckedChange={(checked) =>
              updateSettings({
                mobileRemoteControl: {
                  ...settings.mobileRemoteControl,
                  enabled: Boolean(checked),
                },
              })
            }
            aria-label="Enable mobile remote control"
          />
        }
      />

      <SettingsRow
        title="Default pairing scope"
        description="Keep v1 narrow. Thread control allows prompt send, interrupt, approvals, diff, and archive."
        control={
          <Select
            value={settings.mobileRemoteControl.defaultScope}
            onValueChange={(value) => {
              if (value === "read-only" || value === "approve-only" || value === "thread-control") {
                updateSettings({
                  mobileRemoteControl: {
                    ...settings.mobileRemoteControl,
                    defaultScope: value,
                  },
                });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label="Mobile pairing scope">
              <SelectValue>{settings.mobileRemoteControl.defaultScope}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="read-only">
                read-only
              </SelectItem>
              <SelectItem hideIndicator value="approve-only">
                approve-only
              </SelectItem>
              <SelectItem hideIndicator value="thread-control">
                thread-control
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title="Mobile app URL"
        description="Where the separate apps/mobile-web companion is hosted."
      >
        <div className="mt-3">
          <Input value={mobileBaseUrl} onChange={(event) => setMobileBaseUrl(event.target.value)} />
        </div>
      </SettingsRow>

      <SettingsRow
        title="Backend URL"
        description="The phone must be able to reach this desktop server origin from the same network or tailnet. Use the HTTP origin only, without auth tokens."
      >
        <div className="mt-3 space-y-3">
          <Input
            value={backendBaseUrl}
            onChange={(event) => setBackendBaseUrl(event.target.value)}
            onBlur={() => setBackendBaseUrl((current) => normalizeBackendBaseUrl(current))}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!settings.mobileRemoteControl.enabled || createPairingMutation.isPending}
              onClick={() => {
                setPairingLink(null);
                setPairingError(null);
                createPairingMutation.mutate();
              }}
            >
              {createPairingMutation.isPending ? "Creating..." : "Create pairing link"}
            </Button>
            {pairingLink ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigator.clipboard.writeText(pairingLink)}
              >
                Copy link
              </Button>
            ) : null}
          </div>
          {pairingError ? <p className="text-xs text-destructive">{pairingError}</p> : null}
          {pairingLink ? (
            <p className="break-all text-xs text-muted-foreground">{pairingLink}</p>
          ) : null}
        </div>
      </SettingsRow>

      <SettingsRow
        title="Active sessions"
        description="Revoke any paired phone immediately if you no longer trust it."
      >
        <div className="mt-3 space-y-2">
          {sessionsQuery.isError ? (
            <p className="text-xs text-destructive">
              {sessionsQuery.error instanceof Error
                ? sessionsQuery.error.message
                : "Failed to load mobile sessions."}
            </p>
          ) : null}
          {sessionsQuery.data?.sessions.length ? (
            sessionsQuery.data.sessions.map((session) => (
              <div
                key={session.sessionId}
                className="flex flex-col gap-2 rounded-xl border border-border px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{session.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {session.scope} · expires {new Date(session.expiresAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={session.revokedAt !== null || revokeSessionMutation.isPending}
                  onClick={() => revokeSessionMutation.mutate(session.sessionId)}
                >
                  {session.revokedAt === null ? "Revoke" : "Revoked"}
                </Button>
              </div>
            ))
          ) : sessionsQuery.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading mobile sessions...</p>
          ) : (
            <p className="text-xs text-muted-foreground">No active mobile sessions.</p>
          )}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
