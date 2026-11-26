/**
 * Typed refusal for an SSH operation that has no Rust owner route. SSH runs
 * only through the owner (S4); nothing in TypeScript launches `ssh`,
 * `ssh-keygen`, `ssh-keyscan`, `scp` or `rsync`.
 *
 * @module sshOwnerRequired
 */
export class SshOwnerRequiredError extends Error {
  constructor() {
    super(
      "This SSH operation is unavailable without an SSH owner route. No SSH process was started.",
    );
    this.name = "SshOwnerRequiredError";
  }
}
