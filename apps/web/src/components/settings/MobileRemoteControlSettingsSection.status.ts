import type { DesktopTailscaleRemoteAccessStatus } from "@bigbud/contracts";
import type { Dispatch, SetStateAction } from "react";

import type { AppCheckStatus } from "../../lib/checkStatus";
import {
  normalizeBackendBaseUrl,
  resolveDefaultBackendBaseUrl,
  resolveStoredBackendBaseUrl,
  shouldPreferLiveBackendBaseUrl,
} from "./mobileRemoteControl.urls";

export const MOBILE_WEB_BASE_URL_STORAGE_KEY = "bigbud:mobile-web:base-url:v1";
export const MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY = "bigbud:mobile-remote:backend-url:v1";

export function readStoredBackendBaseUrl(): string {
  if (typeof window === "undefined") {
    return normalizeBackendBaseUrl(resolveDefaultBackendBaseUrl());
  }
  return resolveStoredBackendBaseUrl(
    window.localStorage.getItem(MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY),
  );
}

export function syncTailscaleDerivedUrls(input: {
  readonly status: DesktopTailscaleRemoteAccessStatus;
  readonly setBackendBaseUrl: Dispatch<SetStateAction<string>>;
}) {
  const nextBackend = normalizeBackendBaseUrl(
    input.status.serving && input.status.remoteBaseUrl
      ? input.status.remoteBaseUrl
      : resolveDefaultBackendBaseUrl(),
  );
  input.setBackendBaseUrl((current) => {
    if (!shouldPreferLiveBackendBaseUrl(normalizeBackendBaseUrl(current), nextBackend)) {
      return current;
    }
    window.localStorage.setItem(MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY, nextBackend);
    return nextBackend;
  });
}

export function resolveMobileRemoteControlStatus(input: {
  readonly enabled: boolean;
  readonly activeSessionCount: number;
}) {
  if (!input.enabled) {
    return "Disabled. Mobile sessions are rejected until you enable mobile remote control.";
  }
  return `${input.activeSessionCount} active mobile session${input.activeSessionCount === 1 ? "" : "s"}.`;
}

export interface TailscaleRemoteBackendCheck {
  readonly status: AppCheckStatus;
  readonly message: string;
  readonly tip: string | null;
}

function resolveTailscaleErrorTip(status: DesktopTailscaleRemoteAccessStatus): string {
  if (!status.installed) {
    return "Install Tailscale, sign in to your tailnet, then enable Tailscale Serve.";
  }
  if (!status.running) {
    return "Start the Tailscale daemon on this machine, then try again.";
  }
  if (!status.online) {
    return "Reconnect this device to your tailnet so mobile clients can reach it.";
  }
  if (!status.serving) {
    return "Enable Tailscale Serve so this desktop backend is exposed over HTTPS.";
  }
  return "Check the Tailscale daemon, Serve configuration, and network reachability, then try again.";
}

export function resolveTailscaleRemoteBackendCheck(input: {
  readonly isLoading: boolean;
  readonly status: DesktopTailscaleRemoteAccessStatus | null;
  readonly isMutating: boolean;
  readonly mutationErrorMessage?: string | null;
}): TailscaleRemoteBackendCheck {
  if (input.isLoading || input.isMutating) {
    return {
      status: "checking",
      message: "Checking Tailscale remote access.",
      tip: "bigbud is still checking whether this desktop backend is reachable through Tailscale Serve.",
    };
  }
  if (input.mutationErrorMessage) {
    return {
      status: "error",
      message: input.mutationErrorMessage,
      tip: "Check that Tailscale is installed, running, and allowed to expose this backend.",
    };
  }
  if (!input.status) {
    return {
      status: "idle",
      message: "Desktop-only. Use Tailscale Serve to reach this backend from another Wi-Fi.",
      tip: null,
    };
  }
  if (input.status.serving && input.status.remoteBaseUrl) {
    return {
      status: "verified",
      message: `Remote backend available at ${input.status.remoteBaseUrl}.`,
      tip: null,
    };
  }
  if (input.status.error) {
    return {
      status: "error",
      message: input.status.error,
      tip: resolveTailscaleErrorTip(input.status),
    };
  }
  return {
    status: "checking",
    message: "Checking Tailscale remote access.",
    tip: "bigbud is still checking whether this desktop backend is reachable through Tailscale Serve.",
  };
}
