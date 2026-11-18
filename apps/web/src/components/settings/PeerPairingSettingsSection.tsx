import { useCallback, useEffect, useState } from "react";
import type {
  PeerPairingRequest,
  PeerPairingResult,
  PeerPairingView,
} from "@bigbud/contracts/server/remotePeer.pairing.ts";

import { readNativeApi } from "../../rpc/nativeApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PeerPairingForm } from "./PeerPairingSettingsSection.form";
import { PEER_TONE_CLASS, peerPairingStatus } from "./PeerPairingSettingsSection.logic";
import { SettingsSection } from "./settingsLayout";

function Command(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{props.label}</p>
      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-all">
        {props.value}
      </pre>
    </div>
  );
}

function PairingRow(props: {
  readonly pairing: PeerPairingView;
  readonly publicKeyFile: string | null;
  readonly busy: boolean;
  readonly run: (request: PeerPairingRequest) => Promise<PeerPairingResult | null>;
}) {
  const { pairing } = props;
  const [grantId, setGrantId] = useState("");
  const status = peerPairingStatus(pairing);
  return (
    <div className="space-y-3 border-t p-4 first:border-t-0" data-testid="peer-pairing">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {pairing.label}{" "}
          <span className="text-xs text-muted-foreground">
            {pairing.user}@{pairing.host}:{pairing.port}
          </span>
        </p>
        <span className={`text-xs font-medium ${PEER_TONE_CLASS[status.tone]}`}>
          {status.label}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Pinned host key {pairing.hostKeyFingerprint}; {pairing.provider} in {pairing.workspaceRoot}{" "}
        up to {pairing.runtimeMode}.
      </p>
      {pairing.setupError ? (
        <p className={`text-xs ${PEER_TONE_CLASS.failure}`} role="alert">
          {pairing.setupError.message}
        </p>
      ) : null}
      {pairing.state !== "active" ? (
        <>
          <Command
            label={`On the worker: copy ${props.publicKeyFile ?? "the coordinator public key"} there as ./peer_ed25519.pub, then run`}
            value={pairing.grantCommand}
          />
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label={`Grant id for ${pairing.label}`}
              className="max-w-80 text-sm"
              placeholder="Grant id printed by bigbud peer grant"
              value={grantId}
              onChange={(event) => setGrantId(event.target.value)}
            />
            <Button
              variant="outline"
              disabled={props.busy || !grantId.trim()}
              onClick={() =>
                void props
                  .run({
                    action: "record-grant",
                    pairingId: pairing.pairingId,
                    grantId: grantId.trim(),
                  })
                  .then((result) => result && setGrantId(""))
              }
            >
              Record grant
            </Button>
          </div>
        </>
      ) : null}
      {pairing.revokeCommand && pairing.state === "revoked" ? (
        <Command label="Also revoke on the worker" value={pairing.revokeCommand} />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {pairing.state === "active" ? (
          <Button
            variant="outline"
            disabled={props.busy}
            onClick={() => void props.run({ action: "revoke", pairingId: pairing.pairingId })}
          >
            Revoke grant
          </Button>
        ) : null}
        <Button
          variant="ghost"
          disabled={props.busy}
          onClick={() =>
            void props.run({ action: "delete-connection", pairingId: pairing.pairingId })
          }
        >
          Delete saved connection
        </Button>
      </div>
      {pairing.state === "active" ? (
        <p className="text-xs text-muted-foreground">
          Deleting the saved connection does not revoke the worker grant; revoke it first, then run
          the worker-side revoke command.
        </p>
      ) : null}
    </div>
  );
}

/** P8 coordinator pairing: coordinator key, worker host pins, grants and revocation. */
export function PeerPairingSettingsSection() {
  const [state, setState] = useState<PeerPairingResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const run = useCallback(async (request: PeerPairingRequest) => {
    const api = readNativeApi();
    if (!api?.server.peerPairing) {
      setUnavailable(true);
      return null;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.server.peerPairing(request);
      setState(result);
      if (request.action !== "status" && request.action !== "scan-host-key")
        setNotice({ error: false, message: "Saved." });
      return result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The request failed.";
      if ((cause as { code?: string }).code === "unavailable") setUnavailable(true);
      setNotice({ error: true, message });
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run({ action: "status" });
  }, [run]);

  const coordinator = state?.coordinator;
  return (
    <SettingsSection title="Peer hosts">
      {unavailable ? (
        <p className="p-4 text-sm text-muted-foreground">
          Peer delegation is available when this app is connected to a remote backend.
        </p>
      ) : (
        <>
          <div className="space-y-3 p-4">
            <p className="text-xs text-muted-foreground">
              Let agents on this backend delegate tasks to other bigbud hosts with delegate_to_host.
              Only the public half of a dedicated coordinator key is copied to workers.
            </p>
            {coordinator?.publicKey ? (
              <Command
                label={`Coordinator key ${coordinator.fingerprint} (${coordinator.publicKeyFile})`}
                value={coordinator.publicKey}
              />
            ) : (
              <Button disabled={busy} onClick={() => void run({ action: "ensure-key" })}>
                Generate coordinator key
              </Button>
            )}
          </div>
          {(state?.pairings ?? []).map((pairing) => (
            <PairingRow
              key={pairing.pairingId}
              pairing={pairing}
              publicKeyFile={coordinator?.publicKeyFile ?? null}
              busy={busy}
              run={run}
            />
          ))}
          {coordinator?.publicKey ? <PeerPairingForm busy={busy} run={run} /> : null}
        </>
      )}
      {notice ? (
        <p
          role="status"
          className={`px-4 pb-4 text-xs ${notice.error ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
        >
          {notice.message}
        </p>
      ) : null}
    </SettingsSection>
  );
}
