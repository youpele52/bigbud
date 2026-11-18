import {
  allowsMobileCredentialOrigin,
  currentMobileDeploymentPolicy,
} from "../logic/mobileDeploymentPolicy";
import { MobileCrossHostNavigation } from "../components/shell/MobileCrossHostNavigation";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useState } from "react";

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
import { useMobileRequestOwner } from "../hooks/useMobileRequestOwner";
import { writeMobileSession } from "../lib/mobileSession";
import { useMobileHosts } from "../context/MobileHostsContext";
import {
  EMPTY_MOBILE_HOST_COLLECTION,
  MOBILE_HOST_STORAGE_UNCONFIRMED_MESSAGE,
} from "../lib/mobileHostCollection";
import { MobileHostAdmissionRejectedError } from "../lib/mobileHostConnection";
import { fetchMobileHostDescriptor } from "../logic/mobileHostAdmission";
import { compareRemoteBackendMobileIdentity } from "@bigbud/shared/remoteBackendIdentity";
import { MOBILE_HOST_REVISION_SUPPORT } from "../logic/mobileHostAdmission";
import {
  mobilePairingConfirmationKey,
  mobilePairingIdentityDecision,
  mobilePairingSecret,
} from "./MobilePair.logic";
import {
  normalizePairingBackendOrigin,
  readMobilePairingStatus,
  exchangeMobilePairing,
} from "./MobilePair.request";
import { useMobileSessionState } from "../context/MobileSessionContext";
import { MobileConnectionDiagnostics } from "../components/shell/MobileConnectionDiagnostics";
import {
  classifyMobilePairingHttpFailure,
  MOBILE_PAIRING_TIMEOUT_MESSAGE,
  type MobileConnectionDiagnosticsInput,
} from "../logic/mobileConnectionDiagnostics.logic";

function formatMobileBackendError(error: unknown): string {
  if (
    error instanceof Error &&
    (error.message === "Load failed" || error.message === "Failed to fetch")
  ) {
    return "Could not reach the backend host. Confirm Tailscale is connected on this phone.";
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Could not reach the backend host.";
}

export function MobilePair({ pairingId }: { pairingId: string }) {
  const navigate = useNavigate();
  const hosts = useMobileHosts();
  const href = useRouterState({ select: (state) => state.location.href });
  const { session: activeSession, setSession } = useMobileSessionState();
  const previousSession =
    activeSession ??
    (hosts?.hosts.selected
      ? { backendBaseUrl: hosts.hosts.selected.backendOrigin }
      : (hosts?.legacySession ?? null));
  const [label, setLabel] = useState("mobile-device");
  const [error, setError] = useState<string | null>(null);
  const [exchangeHttp, setExchangeHttp] = useState<MobileConnectionDiagnosticsInput["http"]>();
  const pairingUrl = useMemo(() => new URL(href, window.location.origin), [href]);
  const rawBackendBaseUrl = pairingUrl.searchParams.get("backend");
  const backendBaseUrl = normalizePairingBackendOrigin(rawBackendBaseUrl, true);
  const invalidBackendBaseUrl = rawBackendBaseUrl !== null && !backendBaseUrl;
  const credentialAllowed =
    !!backendBaseUrl &&
    allowsMobileCredentialOrigin(currentMobileDeploymentPolicy(), backendBaseUrl);
  const secret = credentialAllowed ? mobilePairingSecret(pairingUrl.href) : "";
  const missingSecret = !secret;
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const binding = useMemo(() => ({ href, pairingId }), [href, pairingId]);
  const owner = useMobileRequestOwner(binding);
  useLayoutEffect(() => {
    setPairing(false);
    setError(null);
    setExchangeHttp(undefined);
  }, [binding]);
  const descriptorQuery = useQuery({
    enabled: credentialAllowed && backendBaseUrl.startsWith("https:"),
    queryKey: ["mobile-pairing-identity", backendBaseUrl],
    queryFn: ({ signal }) => fetchMobileHostDescriptor(backendBaseUrl, { signal }),
    retry: 0,
  });
  const descriptor =
    descriptorQuery.data?.status === "descriptor" ? descriptorQuery.data.descriptor : null;
  const identityKey = descriptor ? mobilePairingConfirmationKey(backendBaseUrl, descriptor) : null;
  const atOrigin = hosts?.hosts.value.collection.entries.find(
    (entry) => entry.backendOrigin === backendBaseUrl,
  );
  const identityDecision = descriptor
    ? mobilePairingIdentityDecision({
        collection: hosts?.hosts.value ?? EMPTY_MOBILE_HOST_COLLECTION,
        backendOrigin: backendBaseUrl,
        descriptor,
        confirmedFirstSeen: confirmedKey === identityKey,
      })
    : null;
  const identityBlocked =
    backendBaseUrl.startsWith("https:") &&
    (!descriptorQuery.data ||
      descriptorQuery.isError ||
      (descriptor ? !identityDecision?.allowed : !!atOrigin));

  const statusQuery = useQuery({
    enabled: credentialAllowed,
    queryKey: ["mobile-pairing", backendBaseUrl, pairingId],
    queryFn: ({ signal }) => readMobilePairingStatus(backendBaseUrl, pairingId, signal),
    retry: 0,
  });
  const pairingUnavailableMessage = useMemo(() => {
    if (!statusQuery.data || statusQuery.data.available) {
      return null;
    }
    if (!statusQuery.data.enabled) {
      return "Mobile remote control is disabled on this host.";
    }
    return "This pairing link has already been used or expired. Create a fresh pairing link from this host.";
  }, [statusQuery.data]);

  async function confirmPairing() {
    const lease = owner.current;
    if (!credentialAllowed || hosts?.hosts.error) return;
    if (lease.request || !lease.active) return;
    const request = new AbortController();
    lease.request = request;
    const timeout = window.setTimeout(
      () => request.abort(new Error(MOBILE_PAIRING_TIMEOUT_MESSAGE)),
      10_000,
    );
    const expectedRevision = hosts?.hosts.getRevision();
    setPairing(true);
    setError(null);
    setExchangeHttp(undefined);
    try {
      if (!backendBaseUrl || !statusQuery.data)
        throw new Error("This link is missing a valid backend origin or pairing status.");
      const currentStatus = await readMobilePairingStatus(
        backendBaseUrl,
        pairingId,
        request.signal,
      );
      if (!currentStatus.available || currentStatus.scope !== statusQuery.data.scope)
        throw new Error(
          "Pairing scope or availability changed. Open a fresh link and review it again.",
        );
      if (backendBaseUrl.startsWith("https:")) {
        const current = await fetchMobileHostDescriptor(backendBaseUrl, { signal: request.signal });
        if (descriptor) {
          if (
            current.status !== "descriptor" ||
            compareRemoteBackendMobileIdentity(
              current.descriptor,
              descriptor,
              MOBILE_HOST_REVISION_SUPPORT,
            ) !== "match"
          )
            throw new Error("Backend identity changed while pairing. Review a fresh pairing link.");
          const admission = mobilePairingIdentityDecision({
            collection: hosts?.hosts.value ?? EMPTY_MOBILE_HOST_COLLECTION,
            backendOrigin: backendBaseUrl,
            descriptor: current.descriptor,
            confirmedFirstSeen: confirmedKey === identityKey,
          });
          if (!admission.allowed) throw new MobileHostAdmissionRejectedError(admission.reason);
        } else if (current.status !== "legacy" || atOrigin)
          throw new Error("Backend identity changed. Reload and review it before pairing.");
      }
      const payload = await exchangeMobilePairing(
        backendBaseUrl,
        pairingId,
        { secret, label: label.trim() || "mobile-device" },
        request.signal,
      );
      if (payload.scope !== currentStatus.scope || Date.parse(payload.expiresAt) <= Date.now())
        throw new Error("The returned authorization no longer matches this pairing link.");
      const nextSession = { ...payload, backendBaseUrl };
      if (!lease.active || request.signal.aborted) return;
      if (descriptor) {
        const current = await fetchMobileHostDescriptor(backendBaseUrl, { signal: request.signal });
        if (
          current.status !== "descriptor" ||
          compareRemoteBackendMobileIdentity(
            current.descriptor,
            descriptor,
            MOBILE_HOST_REVISION_SUPPORT,
          ) !== "match"
        )
          throw new Error("Backend identity changed before authorization could be saved.");
        if (!lease.active || request.signal.aborted) return;
        if (!hosts || expectedRevision === undefined)
          throw new Error("Reload this app before saving a verified backend.");
        const result = hosts.hosts.addPairing({
          descriptor: current.descriptor,
          backendOrigin: backendBaseUrl,
          session: nextSession,
          confirmedFirstSeen: confirmedKey === identityKey,
          expectedRevision,
        });
        if (!result.accepted) throw new Error(result.reason);
      } else {
        if (hosts && expectedRevision !== hosts.hosts.getRevision())
          throw new Error("Selected host changed while pairing. Start again.");
        if (hosts) {
          if (
            expectedRevision === undefined ||
            !hosts.hosts.activateLegacySession(nextSession, expectedRevision)
          )
            throw new Error(MOBILE_HOST_STORAGE_UNCONFIRMED_MESSAGE);
        } else {
          writeMobileSession(nextSession);
          setSession(nextSession);
        }
      }
      await navigate({ to: "/mobile", replace: true, state: {} });
    } catch (error) {
      if (!lease.active) return;
      setExchangeHttp(classifyMobilePairingHttpFailure(error));
      setError(formatMobileBackendError(error));
    } finally {
      window.clearTimeout(timeout);
      if (lease.request === request) lease.request = null;
      if (lease.active) setPairing(false);
    }
  }

  if (backendBaseUrl && !credentialAllowed)
    return <MobileCrossHostNavigation backendOrigin={backendBaseUrl} />;

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
        {descriptor ? (
          <div className="grid gap-2 rounded-lg border border-border p-3 text-xs">
            <p className="break-all">Authority: {descriptor.authority.authorityId}</p>
            <p className="break-all">Key: {descriptor.authority.keyFingerprint}</p>
            {!atOrigin ? (
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmedKey === identityKey}
                  onChange={(event) => setConfirmedKey(event.target.checked ? identityKey : null)}
                />
                I confirm this backend identity and pairing target.
              </label>
            ) : null}
            {identityDecision &&
            !identityDecision.allowed &&
            identityDecision.reason !== "confirmation-required" ? (
              <p className="text-warning" role="alert">
                {new MobileHostAdmissionRejectedError(identityDecision.reason).message}
              </p>
            ) : null}
          </div>
        ) : null}
        {descriptorQuery.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {formatMobileBackendError(descriptorQuery.error)}
          </p>
        ) : null}
        {atOrigin && descriptorQuery.data?.status === "legacy" ? (
          <p className="text-sm text-warning" role="alert">
            This saved backend no longer provides its identity. It cannot be replaced by a legacy
            connection.
          </p>
        ) : null}
        {!backendBaseUrl.startsWith("https:") || descriptorQuery.data?.status === "legacy" ? (
          <MobileMuted>
            Legacy single-connection mode. This target has no verified backend identity.
          </MobileMuted>
        ) : null}
        {statusQuery.data ? <MobileMuted>Scope: {statusQuery.data.scope}</MobileMuted> : null}
        {statusQuery.data ? (
          <MobileMuted>Expires {new Date(statusQuery.data.expiresAt).toLocaleString()}</MobileMuted>
        ) : null}
        {previousSession && backendBaseUrl && previousSession.backendBaseUrl !== backendBaseUrl ? (
          <p className="text-xs text-warning">
            The previous backend and its drafts are kept when this host has a verified identity.
          </p>
        ) : null}
        {pairingUnavailableMessage ? (
          <p className="text-xs text-destructive">{pairingUnavailableMessage}</p>
        ) : null}
        {statusQuery.isLoading ? <MobileMuted>Checking pairing status...</MobileMuted> : null}
        {statusQuery.isError ? (
          <p className="text-xs text-destructive">{formatMobileBackendError(statusQuery.error)}</p>
        ) : null}
        {invalidBackendBaseUrl ? (
          <p className="text-xs text-destructive">
            This pairing link is missing a valid backend origin. Create a fresh link generated by
            the host you want to use.
          </p>
        ) : null}
        {missingSecret ? (
          <p className="text-xs text-destructive">
            This pairing link is missing its secret token. Open the original full link again.
          </p>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {backendBaseUrl && (statusQuery.isError || error) ? (
          <MobileConnectionDiagnostics
            backendBaseUrl={backendBaseUrl}
            http={
              exchangeHttp ??
              (statusQuery.isError ? classifyMobilePairingHttpFailure(statusQuery.error) : "ok")
            }
            pageOrigin={window.location.origin}
          />
        ) : null}
        <MobileActions>
          <Button
            disabled={
              pairing ||
              !!hosts?.hosts.error ||
              !statusQuery.data?.available ||
              invalidBackendBaseUrl ||
              missingSecret ||
              identityBlocked
            }
            onClick={() => void confirmPairing()}
          >
            {pairing ? "Confirming pairing…" : "Confirm pairing"}
          </Button>
        </MobileActions>
      </MobileCard>
    </MobilePage>
  );
}
