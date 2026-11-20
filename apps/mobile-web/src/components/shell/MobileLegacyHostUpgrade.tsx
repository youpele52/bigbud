import { useLayoutEffect, useMemo, useState } from "react";
import {
  compareRemoteBackendMobileIdentity,
  type RemoteBackendIdentityPin,
} from "@bigbud/shared/remoteBackendIdentity";
import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";

import { useMobileHosts } from "../../context/MobileHostsContext";
import { useMobileRequestOwner } from "../../hooks/useMobileRequestOwner";
import {
  fetchMobileHostDescriptor,
  MOBILE_HOST_REVISION_SUPPORT,
} from "../../logic/mobileHostAdmission";
import { MobileHostAdmissionRejectedError } from "../../lib/mobileHostConnection";
import type { StoredMobileSession } from "../../lib/mobileSession";
import { mobilePairingIdentityDecision } from "../../screens/MobilePair.logic";
import { Button } from "../ui/button";

export function MobileLegacyHostUpgrade(props: {
  session: StoredMobileSession | null;
  current: boolean;
}) {
  const context = useMobileHosts();
  if (!context || context.hosts.selected || !props.session?.backendBaseUrl.startsWith("https:"))
    return null;
  return (
    <LegacyHostUpgradeForm session={props.session} current={props.current} context={context} />
  );
}

function LegacyHostUpgradeForm({
  session,
  current,
  context,
}: {
  session: StoredMobileSession;
  current: boolean;
  context: NonNullable<ReturnType<typeof useMobileHosts>>;
}) {
  const binding = useMemo(() => ({ session, current }), [session, current]);
  const owner = useMobileRequestOwner(binding);
  const [observed, setObserved] = useState<{
    descriptor: RemoteBackendMobileDescriptor;
    revision: number;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    setObserved(null);
    setConfirmed(false);
    setBusy(false);
    setError(null);
  }, [binding]);
  const decision = observed
    ? mobilePairingIdentityDecision({
        collection: context.hosts.value,
        backendOrigin: session.backendBaseUrl,
        descriptor: observed.descriptor,
        confirmedFirstSeen: confirmed,
      })
    : null;

  async function verify(save: boolean) {
    const lease = owner.current;
    if (!lease.active || lease.request || !current) return;
    if (save && (!observed || !confirmed)) return;
    const revision = context.hosts.getRevision();
    if (save && observed?.revision !== revision) {
      setError("Saved hosts changed. Refresh this identity before saving.");
      return;
    }
    const request = new AbortController();
    lease.request = request;
    setBusy(true);
    setError(null);
    try {
      const result = await fetchMobileHostDescriptor(session.backendBaseUrl, {
        signal: request.signal,
      });
      if (!lease.active || request.signal.aborted) return;
      if (result.status === "legacy")
        throw new Error(
          "This backend does not provide verified host identity yet. Your existing connection is kept.",
        );
      if (!save) {
        setObserved({ descriptor: result.descriptor, revision });
        setConfirmed(false);
        return;
      }
      const pin: RemoteBackendIdentityPin | null = observed?.descriptor ?? null;
      if (
        !pin ||
        compareRemoteBackendMobileIdentity(result.descriptor, pin, MOBILE_HOST_REVISION_SUPPORT) !==
          "match"
      )
        throw new Error(
          "Backend identity changed. Refresh it and confirm the new target before saving.",
        );
      const allowed = mobilePairingIdentityDecision({
        collection: context.hosts.value,
        backendOrigin: session.backendBaseUrl,
        descriptor: result.descriptor,
        confirmedFirstSeen: true,
      });
      if (!allowed.allowed) throw new MobileHostAdmissionRejectedError(allowed.reason);
      const saved = context.hosts.addPairing({
        descriptor: result.descriptor,
        backendOrigin: session.backendBaseUrl,
        session,
        confirmedFirstSeen: true,
        expectedRevision: revision,
      });
      if (!saved.accepted) throw new Error(saved.reason);
    } catch (error) {
      if (lease.active)
        setError(error instanceof Error ? error.message : "Could not verify this backend.");
    } finally {
      if (lease.request === request) lease.request = null;
      if (lease.active) setBusy(false);
    }
  }

  return (
    <section
      className="grid min-w-0 gap-2 border-t border-border pt-3"
      aria-label="Save current backend identity"
    >
      <p className="text-xs text-muted-foreground">
        Save this authenticated connection as a verified host without replacing its session or
        pending command IDs.
      </p>
      <Button
        className="min-h-11 w-full"
        variant="outline"
        disabled={!current || busy || !!context.hosts.error}
        onClick={() => void verify(false)}
      >
        {observed ? "Refresh backend identity" : "Verify current backend"}
      </Button>
      {!current ? (
        <p className="text-xs text-muted-foreground">
          Reconnect and refresh chats before saving this host.
        </p>
      ) : null}
      {observed ? (
        <div className="grid min-w-0 gap-2 text-xs">
          <p className="[overflow-wrap:anywhere]">{session.backendBaseUrl}</p>
          <p className="break-all">Authority: {observed.descriptor.authority.authorityId}</p>
          <p className="break-all">Key: {observed.descriptor.authority.keyFingerprint}</p>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I confirm this existing backend identity.
          </label>
          {decision && !decision.allowed && decision.reason !== "confirmation-required" ? (
            <p role="alert" className="text-warning">
              {new MobileHostAdmissionRejectedError(decision.reason).message}
            </p>
          ) : null}
          <Button
            className="min-h-11"
            disabled={!decision?.allowed || busy || !current || !!context.hosts.error}
            onClick={() => void verify(true)}
          >
            Save current host
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="text-xs text-warning" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
