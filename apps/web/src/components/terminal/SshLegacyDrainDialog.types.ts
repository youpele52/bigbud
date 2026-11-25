/** One SSH pane shown in the U5/U8 drain consent list. */
export interface SshLegacyDrainPane {
  readonly paneId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly paneTitle: string;
  /** Human route label, for example `builder@host`; never a socket path. */
  readonly route: string;
}

export type SshLegacyDrainPhase = "review" | "submitting" | "error" | "closed";

/**
 * The consent UI contract. The transport supplies the pane list and performs the
 * chosen action; this component never drains anything by itself.
 */
export interface SshLegacyDrainFlow {
  /** `startup-refusal` is the W3.6 fence: SSH is closed until these panes drain. */
  readonly reason?: "upgrade" | "startup-refusal" | undefined;
  readonly phase: SshLegacyDrainPhase;
  readonly panes: ReadonlyArray<SshLegacyDrainPane>;
  readonly error?: string | undefined;
  /** Save each pane's state, then close it and continue the upgrade. */
  saveAndClose: () => void;
  /** Close the listed panes without saving, then continue the upgrade. */
  drainNow: () => void;
  /** Abort the upgrade; nothing is drained and the backend keeps its lock. */
  cancel: () => void;
  /** Re-list panes after an error and return to review. */
  retry: () => void;
}
