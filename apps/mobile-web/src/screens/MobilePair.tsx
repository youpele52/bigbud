import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, useEffect } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  MobileActions,
  MobileCard,
  MobileEyebrow,
  MobileMuted,
  MobilePage,
  MobileTitle,
} from "../components/shell/MobileShell";
import { writeMobileSession } from "../lib/mobileSession";
import { useMobileSessionState } from "../context/MobileSessionContext";

function readPairingSecret() {
  const hash = new URL(window.location.href).hash;
  return hash.startsWith("#secret=") ? decodeURIComponent(hash.slice("#secret=".length)) : "";
}

const MOBILE_PAIRING_REQUEST_TIMEOUT_MS = 10_000;

function formatMobileBackendError(error: unknown): string {
  if (
    error instanceof Error &&
    (error.message === "Load failed" || error.message === "Failed to fetch")
  ) {
    return "Could not reach the desktop backend. Confirm Tailscale is connected on this phone.";
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Could not reach the desktop backend.";
}

function maybeRedirectToSameOriginPairing(pairingId: string, backendBaseUrl: string) {
  if (!backendBaseUrl) {
    return;
  }
  try {
    const backend = new URL(backendBaseUrl);
    if (!backend.hostname.endsWith(".ts.net") || backend.origin === window.location.origin) {
      return;
    }
    const target = `${backend.origin}/mobile/pair/${pairingId}?backend=${encodeURIComponent(backendBaseUrl)}${window.location.hash}`;
    window.location.replace(target);
  } catch {
    // Ignore invalid backend URLs.
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MOBILE_PAIRING_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Timed out reaching the desktop backend.", { cause: error });
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function MobilePair({ pairingId }: { pairingId: string }) {
  const navigate = useNavigate();
  const { setSession } = useMobileSessionState();
  const [label, setLabel] = useState("mobile-device");
  const [error, setError] = useState<string | null>(null);
  const backendBaseUrl = useMemo(() => {
    const backend = new URL(window.location.href).searchParams.get("backend");
    return backend?.trim() ?? "";
  }, []);
  const secret = useMemo(() => readPairingSecret(), []);
  const missingSecret = secret.length === 0;

  useEffect(() => {
    maybeRedirectToSameOriginPairing(pairingId, backendBaseUrl);
  }, [backendBaseUrl, pairingId]);

  const statusQuery = useQuery({
    enabled: backendBaseUrl.length > 0,
    queryKey: ["mobile-pairing", backendBaseUrl, pairingId],
    queryFn: async () => {
      const response = await fetchWithTimeout(`${backendBaseUrl}/api/mobile/pairing/${pairingId}`);
      if (!response.ok) {
        throw new Error("Pairing link is invalid or expired.");
      }
      return response.json() as Promise<{
        pairingId: string;
        scope: string;
        expiresAt: string;
        enabled: boolean;
        available: boolean;
      }>;
    },
    retry: 0,
  });
  const pairingUnavailableMessage = useMemo(() => {
    if (!statusQuery.data || statusQuery.data.available) {
      return null;
    }
    if (!statusQuery.data.enabled) {
      return "Mobile remote control is disabled on the desktop.";
    }
    return "This pairing link has already been used or expired. Create a fresh link from the desktop app.";
  }, [statusQuery.data]);

  async function confirmPairing() {
    setError(null);
    try {
      const response = await fetchWithTimeout(
        `${backendBaseUrl}/api/mobile/pairing/${pairingId}/exchange`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            secret,
            label: label.trim() || "mobile-device",
          }),
        },
      );
      if (!response.ok) {
        throw new Error("Pairing could not be completed.");
      }
      const payload = (await response.json()) as {
        sessionId: string;
        sessionToken: string;
        websocketUrl: string;
        scope: "read-only" | "approve-only" | "thread-control";
        expiresAt: string;
      };
      const nextSession = {
        sessionId: payload.sessionId,
        sessionToken: payload.sessionToken,
        websocketUrl: payload.websocketUrl,
        backendBaseUrl,
        scope: payload.scope,
        expiresAt: payload.expiresAt,
      };
      writeMobileSession(nextSession);
      setSession(nextSession);
      await navigate({ to: "/mobile" });
    } catch (error) {
      setError(formatMobileBackendError(error));
    }
  }

  return (
    <MobilePage>
      <MobileCard>
        <MobileEyebrow>Pair mobile device</MobileEyebrow>
        <MobileTitle>{pairingId}</MobileTitle>
        <MobileMuted className="mt-2">
          Backend: {backendBaseUrl || "Missing backend origin in pairing URL."}
        </MobileMuted>
      </MobileCard>
      <MobileCard className="grid gap-3">
        <label className="grid gap-2 text-sm" htmlFor="device-label">
          <span className="font-medium text-foreground">Device label</span>
          <Input
            id="device-label"
            onChange={(event) => setLabel(event.target.value)}
            value={label}
          />
        </label>
        {statusQuery.data ? (
          <MobileMuted>Expires {new Date(statusQuery.data.expiresAt).toLocaleString()}</MobileMuted>
        ) : null}
        {pairingUnavailableMessage ? (
          <p className="text-xs text-destructive">{pairingUnavailableMessage}</p>
        ) : null}
        {statusQuery.isLoading ? <MobileMuted>Checking pairing status...</MobileMuted> : null}
        {statusQuery.isError ? (
          <p className="text-xs text-destructive">{formatMobileBackendError(statusQuery.error)}</p>
        ) : null}
        {missingSecret ? (
          <p className="text-xs text-destructive">
            This pairing link is missing its secret token. Open the original full link again.
          </p>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <MobileActions>
          <Button
            disabled={!statusQuery.data?.available || missingSecret}
            onClick={() => void confirmPairing()}
          >
            Confirm pairing
          </Button>
        </MobileActions>
      </MobileCard>
    </MobilePage>
  );
}
