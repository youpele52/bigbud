import type { DesktopTailscaleRemoteAccessStatus } from "@bigbud/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { ensureNativeApi } from "../../rpc/nativeApi";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { normalizeBackendBaseUrl, resolveDefaultBackendBaseUrl } from "./mobileRemoteControl.urls";
import { MobileRemoteTailscaleDoctor } from "./MobileRemoteControlSettingsSection.doctor";
import { resolveTailscaleRemoteBackendCheck } from "./MobileRemoteControlSettingsSection.status";
import { resolveTailscaleTakeOverOffer } from "./MobileRemoteControlSettingsSection.takeover.logic";

export const MOBILE_REMOTE_TAILSCALE_QUERY_KEY = ["mobile-remote-tailscale"] as const;

const DESKTOP_ONLY_ERROR = "Tailscale remote access is only available in the desktop app.";

function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

/** Enable, disable and (for another bigbud only) take over this channel's Serve port. */
export function MobileRemoteTailscaleBackendRow({
  status,
  isLoading,
  onBackendBaseUrlChange,
}: {
  readonly status: DesktopTailscaleRemoteAccessStatus | null | undefined;
  readonly isLoading: boolean;
  readonly onBackendBaseUrlChange: (url: string) => void;
}) {
  const queryClient = useQueryClient();
  const adoptServingStatus = async (next: DesktopTailscaleRemoteAccessStatus | null) => {
    // A refused or conflicting result keeps the current backend URL.
    if (next?.serving && next.remoteBaseUrl) {
      onBackendBaseUrlChange(normalizeBackendBaseUrl(next.remoteBaseUrl));
    }
    await queryClient.invalidateQueries({ queryKey: MOBILE_REMOTE_TAILSCALE_QUERY_KEY });
  };
  const enableMutation = useMutation({
    mutationFn: async () => {
      if (!window.desktopBridge?.enableTailscaleRemoteAccess) throw new Error(DESKTOP_ONLY_ERROR);
      return window.desktopBridge.enableTailscaleRemoteAccess();
    },
    onSuccess: adoptServingStatus,
  });
  const takeOverMutation = useMutation({
    mutationFn: async (confirmMessage: string) => {
      if (!window.desktopBridge?.takeOverTailscaleRemoteAccess) throw new Error(DESKTOP_ONLY_ERROR);
      if (!(await ensureNativeApi().dialogs.confirm(confirmMessage))) return null;
      return window.desktopBridge.takeOverTailscaleRemoteAccess();
    },
    onSuccess: adoptServingStatus,
  });
  const disableMutation = useMutation({
    mutationFn: async () => {
      if (!window.desktopBridge?.disableTailscaleRemoteAccess) throw new Error(DESKTOP_ONLY_ERROR);
      return window.desktopBridge.disableTailscaleRemoteAccess();
    },
    onSuccess: async () => {
      onBackendBaseUrlChange(normalizeBackendBaseUrl(resolveDefaultBackendBaseUrl()));
      await queryClient.invalidateQueries({ queryKey: MOBILE_REMOTE_TAILSCALE_QUERY_KEY });
    },
  });

  const isMutating =
    enableMutation.isPending || disableMutation.isPending || takeOverMutation.isPending;
  const mutationErrorMessage =
    errorMessage(enableMutation.error) ??
    errorMessage(takeOverMutation.error) ??
    errorMessage(disableMutation.error);
  const check = useMemo(
    () =>
      resolveTailscaleRemoteBackendCheck({
        isLoading,
        status: status ?? null,
        isMutating,
        mutationErrorMessage,
      }),
    [isLoading, isMutating, mutationErrorMessage, status],
  );
  const takeOverOffer = isMutating ? null : resolveTailscaleTakeOverOffer(status);

  return (
    <SettingsRow
      title="Tailscale remote backend"
      description="Private different-Wi-Fi access. This exposes the desktop backend through your tailnet over HTTPS."
      status={check.message}
    >
      <div className="mt-3 space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={enableMutation.isPending}
            onClick={() => enableMutation.mutate()}
          >
            {enableMutation.isPending ? "Enabling..." : "Enable Tailscale Serve"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disableMutation.isPending}
            onClick={() => disableMutation.mutate()}
          >
            {disableMutation.isPending ? "Disabling..." : "Disable Tailscale Serve"}
          </Button>
        </div>
        {status?.serving && status.remoteBaseUrl ? (
          <p className="break-all text-xs text-muted-foreground">
            Use this as the backend URL for different-Wi-Fi pairing:{" "}
            {normalizeBackendBaseUrl(status.remoteBaseUrl)}
          </p>
        ) : null}
        {takeOverOffer ? (
          <div
            className="space-y-2 rounded-lg border border-amber-500/40 px-3 py-2"
            data-testid="tailscale-take-over"
          >
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {takeOverOffer.description}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => takeOverMutation.mutate(takeOverOffer.confirmMessage)}
            >
              Take over
            </Button>
          </div>
        ) : null}
        {check.tip ? (
          <p
            className={`text-xs ${
              check.status === "error" ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {check.tip}
          </p>
        ) : null}
        {status && !isLoading ? <MobileRemoteTailscaleDoctor status={status} /> : null}
      </div>
    </SettingsRow>
  );
}
