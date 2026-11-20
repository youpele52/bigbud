import { useState } from "react";
import type {
  PeerPairingRequest,
  PeerPairingResult,
  PeerScannedHostKey,
} from "@bigbud/contracts/server/remotePeer.pairing.ts";
import { PROVIDER_KINDS } from "@bigbud/contracts/constants/provider.constant.ts";
import { RUNTIME_MODES } from "@bigbud/contracts/constants/runtime.constant.ts";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  EMPTY_PEER_DRAFT,
  peerSaveRequest,
  type PeerPairingDraft,
} from "./PeerPairingSettingsSection.logic";

const FIELDS: ReadonlyArray<{ key: keyof PeerPairingDraft; label: string; placeholder: string }> = [
  { key: "label", label: "Label", placeholder: "build-worker" },
  { key: "workerAuthorityId", label: "Worker authority id", placeholder: "32 hex characters" },
  { key: "host", label: "SSH host", placeholder: "worker.example.com" },
  { key: "port", label: "SSH port", placeholder: "22" },
  { key: "user", label: "SSH user", placeholder: "bigbud" },
  { key: "workspaceRoot", label: "Worker workspace root", placeholder: "/home/bigbud/project" },
];

const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm";

/** Add or update a saved worker connection; the host key pin needs explicit confirmation. */
export function PeerPairingForm(props: {
  readonly busy: boolean;
  readonly run: (request: PeerPairingRequest) => Promise<PeerPairingResult | null>;
}) {
  const [draft, setDraft] = useState<PeerPairingDraft>(EMPTY_PEER_DRAFT);
  const [scanned, setScanned] = useState<ReadonlyArray<PeerScannedHostKey>>([]);
  const [pin, setPin] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const request = peerSaveRequest(draft, pin, confirmed);
  const update = (key: keyof PeerPairingDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (key === "host" || key === "port") {
      // A different host invalidates any scanned key and confirmation.
      setScanned([]);
      setPin(null);
      setConfirmed(false);
    }
  };
  const scan = async () => {
    const result = await props.run({
      action: "scan-host-key",
      host: draft.host.trim(),
      port: Number(draft.port),
    });
    setScanned(result?.scannedHostKeys ?? []);
    setPin(result?.scannedHostKeys?.[0]?.pinnedHostKey ?? null);
    setConfirmed(false);
  };
  const save = async () => {
    if (typeof request === "string") return;
    if (await props.run(request)) {
      setDraft(EMPTY_PEER_DRAFT);
      setScanned([]);
      setPin(null);
      setConfirmed(false);
    }
  };
  return (
    <div className="space-y-3 border-t p-4">
      <p className="text-sm font-medium">Add a worker host</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((field) => (
          <label key={field.key} className="space-y-1">
            <span className="text-xs text-muted-foreground">{field.label}</span>
            <Input
              aria-label={field.label}
              className="text-sm"
              placeholder={field.placeholder}
              value={draft[field.key]}
              onChange={(event) => update(field.key, event.target.value)}
            />
          </label>
        ))}
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Provider</span>
          <select
            aria-label="Provider"
            className={selectClass}
            value={draft.provider}
            onChange={(event) => update("provider", event.target.value)}
          >
            {PROVIDER_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Runtime mode ceiling</span>
          <select
            aria-label="Runtime mode ceiling"
            className={selectClass}
            value={draft.runtimeMode}
            onChange={(event) => update("runtimeMode", event.target.value)}
          >
            {RUNTIME_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Button
        variant="outline"
        disabled={props.busy || !draft.host.trim()}
        onClick={() => void scan()}
      >
        Scan host key
      </Button>
      {scanned.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="text-xs text-muted-foreground">
            Compare with the worker: run <code>ssh-keygen -lf</code> on its host key file and pick
            the matching key.
          </legend>
          {scanned.map((key) => (
            <label key={key.pinnedHostKey} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="peer-host-key"
                checked={pin === key.pinnedHostKey}
                onChange={() => {
                  setPin(key.pinnedHostKey);
                  setConfirmed(false);
                }}
              />
              <span className="font-mono text-xs">
                {key.pinnedHostKey.split(" ")[0]} {key.fingerprint}
              </span>
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I confirm this fingerprint matches the worker and pin it
          </label>
        </fieldset>
      ) : null}
      {typeof request === "string" ? (
        <p className="text-xs text-muted-foreground">{request}</p>
      ) : null}
      <Button disabled={props.busy || typeof request === "string"} onClick={() => void save()}>
        Save connection
      </Button>
    </div>
  );
}
