/** A direct SSH target has no generic command runner; typed owner verbs are separate. */
export class SelectedSshToolTransportError extends Error {
  readonly code = "unsupported-by-selected-ssh-owner";

  constructor() {
    super(
      "This SSH tool command is unavailable through the Rust SSH owner. Use a typed workspace verb.",
    );
    this.name = "SelectedSshToolTransportError";
  }
}

/** SSH runs only through the owner, so a generic SSH tool command is always refused. */
export function assertSelectedSshToolTransportAvailable(): never {
  throw new SelectedSshToolTransportError();
}
