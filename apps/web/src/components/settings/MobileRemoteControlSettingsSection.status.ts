import type { DesktopTailscaleRemoteAccessStatus } from "@bigbud/contracts";
import type { Dispatch, SetStateAction } from "react";

import type { AppCheckStatus } from "../../lib/checkStatus";
import {
  normalizeBackendBaseUrl,
  resolveDefaultBackendBaseUrl,
  resolveDefaultMobileWebBaseUrl,
  resolveStoredBackendBaseUrl,
  resolveStoredMobileWebBaseUrl,
} from "./mobileRemoteControl.urls";

export const MOBILE_WEB_BASE_URL_STORAGE_KEY = "bigbud:mobile-web:base-url:v1";
export const MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY = "bigbud:mobile-remote:backend-url:v1";

export function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function readStoredBackendBaseUrl(): string {
  if (typeof window === "undefined") {
    return normalizeBackendBaseUrl(resolveDefaultBackendBaseUrl());
  }
  return resolveStoredBackendBaseUrl(
    window.localStorage.getItem(MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY),
  );
}

export function readStoredMobileWebBaseUrl(): string {
  if (typeof window === "undefined") {
    return resolveDefaultMobileWebBaseUrl();
  }
  const backendBaseUrl = readStoredBackendBaseUrl();
  return resolveStoredMobileWebBaseUrl(
    window.localStorage.getItem(MOBILE_WEB_BASE_URL_STORAGE_KEY),
    backendBaseUrl,
  );
}

export function syncTailscaleDerivedUrls(input: {
  readonly status: DesktopTailscaleRemoteAccessStatus;
  readonly setBackendBaseUrl: Dispatch<SetStateAction<string>>;
  readonly setMobileBaseUrl: Dispatch<SetStateAction<string>>;
  readonly shouldPreferLiveBackendBaseUrl: (currentBaseUrl: string, nextBaseUrl: string) => boolean;
  readonly shouldResetMobileAppUrlToHosted: (
    currentMobileBaseUrl: string,
    nextBackendBaseUrl: string,
  ) => boolean;
  readonly resolveHostedMobileWebBaseUrl: () => string;
  readonly resolveDefaultBackendBaseUrl: () => string;
  readonly resolveDefaultMobileWebBaseUrl: () => string;
}) {
  if (input.status.serving && input.status.remoteBaseUrl) {
    const nextRemoteBaseUrl = normalizeBackendBaseUrl(input.status.remoteBaseUrl);
    input.setBackendBaseUrl((current) => {
      const normalizedCurrent = normalizeBackendBaseUrl(current);
      if (!input.shouldPreferLiveBackendBaseUrl(normalizedCurrent, nextRemoteBaseUrl)) {
        return current;
      }
      window.localStorage.setItem(MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY, nextRemoteBaseUrl);
      return nextRemoteBaseUrl;
    });
    input.setMobileBaseUrl((current) => {
      if (!input.shouldResetMobileAppUrlToHosted(current, nextRemoteBaseUrl)) {
        return current;
      }
      const nextMobileBaseUrl = stripTrailingSlash(input.resolveHostedMobileWebBaseUrl());
      window.localStorage.setItem(MOBILE_WEB_BASE_URL_STORAGE_KEY, nextMobileBaseUrl);
      return nextMobileBaseUrl;
    });
    return;
  }

  const nextLocalBackend = normalizeBackendBaseUrl(input.resolveDefaultBackendBaseUrl());
  const nextLocalMobile = stripTrailingSlash(input.resolveDefaultMobileWebBaseUrl());
  input.setBackendBaseUrl((current) => {
    const normalizedCurrent = normalizeBackendBaseUrl(current);
    if (!input.shouldPreferLiveBackendBaseUrl(normalizedCurrent, nextLocalBackend)) {
      return current;
    }
    window.localStorage.setItem(MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY, nextLocalBackend);
    return nextLocalBackend;
  });
  input.setMobileBaseUrl((current) => {
    if (!input.shouldResetMobileAppUrlToHosted(current, nextLocalBackend)) {
      return current;
    }
    window.localStorage.setItem(MOBILE_WEB_BASE_URL_STORAGE_KEY, nextLocalMobile);
    return nextLocalMobile;
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
