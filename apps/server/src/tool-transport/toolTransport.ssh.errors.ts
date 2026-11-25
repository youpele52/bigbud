import { isSshOwnerSelected } from "../ssh/sshOwnerSelection.ts";

/** Selected owner domains have no generic SSH command runner; typed verbs are separate. */
export class SelectedSshToolTransportError extends Error {
  readonly code = "unsupported-by-selected-ssh-owner";

  constructor() {
    super(
      "This SSH tool command is unavailable with the source-dev Rust SSH owner. Use a typed workspace verb.",
    );
    this.name = "SelectedSshToolTransportError";
  }
}

export function assertSelectedSshToolTransportAvailable(): void {
  if (isSshOwnerSelected()) throw new SelectedSshToolTransportError();
}
