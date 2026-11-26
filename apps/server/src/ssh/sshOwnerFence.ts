/**
 * Shared legacy-launch fence error. The dev fixture selector and the production
 * selector both throw this exact class so call sites and tests keep one type.
 *
 * @module sshOwnerFence
 */

export class LegacySshDisabledError extends Error {
  constructor() {
    super(
      "This SSH operation is unavailable with the selected SSH owner. No legacy SSH process was started.",
    );
    this.name = "LegacySshDisabledError";
  }
}

/** Throws when any SSH owner is selected. Kept side-effect free for both selectors. */
export function assertLegacySshLaunchAllowedWhen(selected: boolean): void {
  if (selected) throw new LegacySshDisabledError();
}
