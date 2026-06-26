import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

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

  const statusQuery = useQuery({
    enabled: backendBaseUrl.length > 0,
    queryKey: ["mobile-pairing", backendBaseUrl, pairingId],
    queryFn: async () => {
      const response = await fetch(`${backendBaseUrl}/api/mobile/pairing/${pairingId}`);
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
  });

  async function confirmPairing() {
    setError(null);
    try {
      const response = await fetch(`${backendBaseUrl}/api/mobile/pairing/${pairingId}/exchange`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          secret,
          label: label.trim() || "mobile-device",
        }),
      });
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
          <MobileMuted>
            Scope {statusQuery.data.scope} · expires{" "}
            {new Date(statusQuery.data.expiresAt).toLocaleString()}
          </MobileMuted>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <MobileActions>
          <Button
            disabled={!statusQuery.data?.available || secret.length === 0}
            onClick={() => void confirmPairing()}
          >
            Confirm pairing
          </Button>
        </MobileActions>
      </MobileCard>
    </MobilePage>
  );
}
