/**
 * Development-fixture SSH-owner selector.
 *
 * **Fixture/test only.** `activateDevSshOwner` is called by the source-dev entry
 * (`server.sshOwnerDev.ts`) and by focused tests. Production code must not
 * import this module directly; it imports `sshOwnerSelection.ts`, which is the
 * single bridge that also understands the build-time production activation.
 *
 * W7 deletes this module together with the dev selector and the legacy launch
 * branches it guards.
 *
 * @module sshOwnerDevMode.fixture
 */
import { assertLegacySshLaunchAllowedWhen, LegacySshDisabledError } from "./sshOwnerFence.ts";

export { LegacySshDisabledError };

let selected = false;

/** Only the source-dev server entry may activate the fence, before creating its service graph. */
export function activateDevSshOwner(): void {
  selected = true;
}

export function isDevSshOwnerSelected(): boolean {
  return selected;
}

/** Dev-only fence helper. Production fences use `sshOwnerSelection.ts`. */
export function assertLegacySshLaunchAllowed(): void {
  assertLegacySshLaunchAllowedWhen(isDevSshOwnerSelected());
}
