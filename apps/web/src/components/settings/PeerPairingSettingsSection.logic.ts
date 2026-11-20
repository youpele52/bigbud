import type {
  PeerPairingRequest,
  PeerPairingView,
} from "@bigbud/contracts/server/remotePeer.pairing.ts";

/** Toast/status semantics: blue working, green done, amber warning, red failure. */
export type PeerStatusTone = "working" | "done" | "warning" | "failure";

export const PEER_TONE_CLASS: Record<PeerStatusTone, string> = {
  working: "text-blue-600 dark:text-blue-400",
  done: "text-green-600 dark:text-green-400",
  warning: "text-amber-600 dark:text-amber-400",
  failure: "text-red-600 dark:text-red-400",
};

export function peerPairingStatus(pairing: PeerPairingView): {
  readonly tone: PeerStatusTone;
  readonly label: string;
} {
  if (pairing.setupError)
    return {
      tone: "failure",
      label:
        pairing.setupError.code === "host-identity-mismatch"
          ? "Host key mismatch"
          : "Key refused by worker",
    };
  if (pairing.state === "revoked") return { tone: "warning", label: "Revoked" };
  if (pairing.state === "awaiting-grant") return { tone: "warning", label: "Awaiting grant" };
  if (pairing.unsettledDispatches > 0)
    return { tone: "working", label: `Active, ${pairing.unsettledDispatches} running` };
  return { tone: "done", label: "Active" };
}

export interface PeerPairingDraft {
  readonly label: string;
  readonly workerAuthorityId: string;
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly workspaceRoot: string;
  readonly provider: string;
  readonly runtimeMode: string;
}

export const EMPTY_PEER_DRAFT: PeerPairingDraft = {
  label: "",
  workerAuthorityId: "",
  host: "",
  port: "22",
  user: "",
  workspaceRoot: "",
  provider: "codex",
  runtimeMode: "approval-required",
};

/** The save request, or the first problem; the pin is only sent once explicitly confirmed. */
export function peerSaveRequest(
  draft: PeerPairingDraft,
  pinnedHostKey: string | null,
  confirmed: boolean,
): Extract<PeerPairingRequest, { action: "save" }> | string {
  const port = Number(draft.port);
  if (!/^[A-Za-z0-9 ._@:-]{1,64}$/.test(draft.label.trim())) return "Enter a short label.";
  if (!/^[0-9a-f]{32}$/.test(draft.workerAuthorityId.trim()))
    return "The worker authority id is 32 lowercase hex characters.";
  if (!draft.host.trim()) return "Enter the worker host.";
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "Enter a valid SSH port.";
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/.test(draft.user.trim())) return "Enter the worker SSH user.";
  if (!draft.workspaceRoot.startsWith("/")) return "The workspace root is an absolute path.";
  if (!pinnedHostKey) return "Scan and choose the worker host key.";
  if (!confirmed) return "Confirm that the fingerprint matches the worker.";
  return {
    action: "save",
    label: draft.label.trim(),
    workerAuthorityId: draft.workerAuthorityId.trim(),
    host: draft.host.trim(),
    port,
    user: draft.user.trim(),
    pinnedHostKey,
    confirmPin: true,
    workspaceRoot: draft.workspaceRoot,
    provider: draft.provider as Extract<PeerPairingRequest, { action: "save" }>["provider"],
    runtimeMode: draft.runtimeMode as Extract<
      PeerPairingRequest,
      { action: "save" }
    >["runtimeMode"],
  };
}
