let selected = false;

/** Only the source-dev server entry may activate the fence, before creating its service graph. */
export function activateDevSshOwner(): void {
  selected = true;
}

export function isDevSshOwnerSelected(): boolean {
  return selected;
}

export class LegacySshDisabledError extends Error {
  constructor() {
    super(
      "This SSH operation is unavailable with the source-dev SSH owner. No legacy SSH process was started.",
    );
    this.name = "LegacySshDisabledError";
  }
}

export function assertLegacySshLaunchAllowed(): void {
  if (isDevSshOwnerSelected()) throw new LegacySshDisabledError();
}
