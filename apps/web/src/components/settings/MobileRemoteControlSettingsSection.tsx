import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, SmartphoneIcon, TabletSmartphoneIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ensureNativeApi } from "../../rpc/nativeApi";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  resolveHostedMobileWebBaseUrl,
  resolveLocalMobileWebBaseUrl,
  normalizeBackendBaseUrl,
  resolveDefaultBackendBaseUrl,
  resolveDefaultMobileWebBaseUrl,
  shouldPreferLiveBackendBaseUrl,
  shouldResetMobileAppUrlToHosted,
} from "./mobileRemoteControl.urls";
import { MobileRemotePairingQrCode } from "./MobileRemotePairingQrCode";
import {
  MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY,
  MOBILE_WEB_BASE_URL_STORAGE_KEY,
  readStoredBackendBaseUrl,
  readStoredMobileWebBaseUrl,
  resolveMobileRemoteControlStatus,
  resolveTailscaleRemoteBackendCheck,
  stripTrailingSlash,
  syncTailscaleDerivedUrls,
} from "./MobileRemoteControlSettingsSection.status";

const MOBILE_REMOTE_SESSIONS_QUERY_KEY = ["mobile-remote-sessions"] as const;
const MOBILE_REMOTE_TAILSCALE_QUERY_KEY = ["mobile-remote-tailscale"] as const;

export function MobileRemoteControlSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const queryClient = useQueryClient();
  const [mobileBaseUrl, setMobileBaseUrl] = useState(readStoredMobileWebBaseUrl);
  const [backendBaseUrl, setBackendBaseUrl] = useState(readStoredBackendBaseUrl);
  const [pairingLink, setPairingLink] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);

  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add({ type: "success", title: "Link copied to clipboard" });
    },
    onError: (error) => {
      toastManager.add({ type: "error", title: "Failed to copy link", description: error.message });
    },
  });

  const sessionsQuery = useQuery({
    queryKey: MOBILE_REMOTE_SESSIONS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listMobileRemoteSessions(),
    staleTime: 5_000,
  });
  const tailscaleQuery = useQuery({
    queryKey: MOBILE_REMOTE_TAILSCALE_QUERY_KEY,
    queryFn: async () => {
      if (!window.desktopBridge?.getTailscaleRemoteAccessStatus) {
        return null;
      }
      return window.desktopBridge.getTailscaleRemoteAccessStatus();
    },
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
  const tailscaleStatus = tailscaleQuery.data;
  const hostedMobileBaseUrl = resolveHostedMobileWebBaseUrl();
  const localDevMobileBaseUrl = resolveLocalMobileWebBaseUrl();

  useEffect(() => {
    const status = tailscaleStatus;
    if (!status) {
      return;
    }
    syncTailscaleDerivedUrls({
      status,
      setBackendBaseUrl,
      setMobileBaseUrl,
      shouldPreferLiveBackendBaseUrl,
      shouldResetMobileAppUrlToHosted,
      resolveHostedMobileWebBaseUrl,
      resolveDefaultBackendBaseUrl,
      resolveDefaultMobileWebBaseUrl,
    });
  }, [tailscaleStatus]);

  const createPairingMutation = useMutation({
    mutationFn: async () => {
      const nextMobileBaseUrl = stripTrailingSlash(mobileBaseUrl.trim());
      const nextBackendBaseUrl = normalizeBackendBaseUrl(backendBaseUrl);
      window.localStorage.setItem(MOBILE_WEB_BASE_URL_STORAGE_KEY, nextMobileBaseUrl);
      window.localStorage.setItem(MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY, nextBackendBaseUrl);
      setBackendBaseUrl(nextBackendBaseUrl);
      return ensureNativeApi().server.createMobileRemotePairing({
        scope: "thread-control",
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
  const enableTailscaleMutation = useMutation({
    mutationFn: async () => {
      if (!window.desktopBridge?.enableTailscaleRemoteAccess) {
        throw new Error("Tailscale remote access is only available in the desktop app.");
      }
      return window.desktopBridge.enableTailscaleRemoteAccess();
    },
    onSuccess: async (status) => {
      if (status.remoteBaseUrl) {
        const nextRemoteBaseUrl = normalizeBackendBaseUrl(status.remoteBaseUrl);
        setBackendBaseUrl(nextRemoteBaseUrl);
        window.localStorage.setItem(MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY, nextRemoteBaseUrl);
        if (shouldResetMobileAppUrlToHosted(mobileBaseUrl, nextRemoteBaseUrl)) {
          const nextMobileBaseUrl = stripTrailingSlash(resolveHostedMobileWebBaseUrl());
          setMobileBaseUrl(nextMobileBaseUrl);
          window.localStorage.setItem(MOBILE_WEB_BASE_URL_STORAGE_KEY, nextMobileBaseUrl);
        }
      }
      await queryClient.invalidateQueries({ queryKey: MOBILE_REMOTE_TAILSCALE_QUERY_KEY });
    },
  });
  const disableTailscaleMutation = useMutation({
    mutationFn: async () => {
      if (!window.desktopBridge?.disableTailscaleRemoteAccess) {
        throw new Error("Tailscale remote access is only available in the desktop app.");
      }
      return window.desktopBridge.disableTailscaleRemoteAccess();
    },
    onSuccess: async () => {
      const nextLocalBackend = normalizeBackendBaseUrl(resolveDefaultBackendBaseUrl());
      const nextLocalMobile = stripTrailingSlash(resolveDefaultMobileWebBaseUrl());
      setBackendBaseUrl(nextLocalBackend);
      setMobileBaseUrl(nextLocalMobile);
      window.localStorage.setItem(MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY, nextLocalBackend);
      window.localStorage.setItem(MOBILE_WEB_BASE_URL_STORAGE_KEY, nextLocalMobile);
      await queryClient.invalidateQueries({ queryKey: MOBILE_REMOTE_TAILSCALE_QUERY_KEY });
    },
  });

  const activeSessionCount =
    sessionsQuery.data?.sessions.filter((session) => session.revokedAt === null).length ?? 0;
  const status = useMemo(
    () =>
      resolveMobileRemoteControlStatus({
        enabled: settings.mobileRemoteControl.enabled,
        activeSessionCount,
      }),
    [activeSessionCount, settings.mobileRemoteControl.enabled],
  );
  const tailscaleCheck = useMemo(
    () =>
      resolveTailscaleRemoteBackendCheck({
        isLoading: tailscaleQuery.isLoading,
        status: tailscaleStatus ?? null,
        isMutating: enableTailscaleMutation.isPending || disableTailscaleMutation.isPending,
        mutationErrorMessage:
          (enableTailscaleMutation.error instanceof Error
            ? enableTailscaleMutation.error.message
            : null) ??
          (disableTailscaleMutation.error instanceof Error
            ? disableTailscaleMutation.error.message
            : null),
      }),
    [
      disableTailscaleMutation.error,
      disableTailscaleMutation.isPending,
      enableTailscaleMutation.error,
      enableTailscaleMutation.isPending,
      tailscaleQuery.isLoading,
      tailscaleStatus,
    ],
  );

  return (
    <>
      <SettingsSection title="Mobile Remote" icon={<SmartphoneIcon className="size-3" />}>
        <SettingsRow
          title="Enable mobile remote control"
          description="Allow mobile sessions to pair with the desktop server."
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
        >
          <p className="pt-1 text-xs text-muted-foreground">
            <a
              href="https://bigbud.app/docs/#advanced-features"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-4 hover:text-foreground hover:decoration-solid"
            >
              Get step-by-step setup help
              <ExternalLinkIcon className="size-3" />
            </a>
          </p>
        </SettingsRow>

        <SettingsRow
          title="Tailscale remote backend"
          description="Private different-Wi-Fi access. This exposes the desktop backend through your tailnet over HTTPS."
          status={tailscaleCheck.message}
        >
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={enableTailscaleMutation.isPending}
                onClick={() => enableTailscaleMutation.mutate()}
              >
                {enableTailscaleMutation.isPending ? "Enabling..." : "Enable Tailscale Serve"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disableTailscaleMutation.isPending}
                onClick={() => disableTailscaleMutation.mutate()}
              >
                {disableTailscaleMutation.isPending ? "Disabling..." : "Disable Tailscale Serve"}
              </Button>
            </div>
            {tailscaleQuery.data?.remoteBaseUrl ? (
              <p className="break-all text-xs text-muted-foreground">
                Use this as the backend URL for different-Wi-Fi pairing:{" "}
                {normalizeBackendBaseUrl(tailscaleQuery.data.remoteBaseUrl)}
              </p>
            ) : null}
            {tailscaleCheck.tip ? (
              <p
                className={`text-xs ${
                  tailscaleCheck.status === "error" ? "text-destructive" : "text-muted-foreground"
                }`}
              >
                {tailscaleCheck.tip}
              </p>
            ) : null}
          </div>
        </SettingsRow>

        <SettingsRow
          title="Mobile app URL"
          description="Root origin of the mobile companion. Pairing links add /mobile automatically."
        >
          <div className="mt-3 space-y-3">
            <Input
              value={mobileBaseUrl}
              onChange={(event) => setMobileBaseUrl(event.target.value)}
            />
            <ToggleGroup
              value={mobileBaseUrl === hostedMobileBaseUrl ? ["production"] : ["local"]}
              onValueChange={(values) => {
                const value = values[0];
                if (value === "production") setMobileBaseUrl(hostedMobileBaseUrl);
                else if (value === "local" && localDevMobileBaseUrl) {
                  setMobileBaseUrl(localDevMobileBaseUrl);
                }
              }}
            >
              <ToggleGroupItem value="production">bigbud</ToggleGroupItem>
              {localDevMobileBaseUrl ? (
                <ToggleGroupItem value="local">Local</ToggleGroupItem>
              ) : null}
            </ToggleGroup>
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
            </div>
            {pairingError ? <p className="text-xs text-destructive">{pairingError}</p> : null}
            {pairingLink ? (
              <div className="space-y-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                  <MobileRemotePairingQrCode value={pairingLink} />
                  <div className="min-w-0 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Scan with your phone camera to open the pairing flow, or copy the link below.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => copyToClipboard(pairingLink)}
                    >
                      {isCopied ? "Copied!" : "Copy link"}
                    </Button>
                    <p className="break-all text-xs text-muted-foreground">{pairingLink}</p>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Active sessions" icon={<TabletSmartphoneIcon className="size-3" />}>
        <div className="space-y-3 px-4 py-4 sm:px-5">
          <p className="text-xs text-muted-foreground">
            Revoke any paired phone immediately if you no longer trust it.
          </p>
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
                    Expires {new Date(session.expiresAt).toLocaleString()}
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
      </SettingsSection>
    </>
  );
}
