import type { MobileHostEntry } from "../lib/mobileHostConnection";
import { clearMobileSession, type StoredMobileSession } from "../lib/mobileSession";
import { clearMobileDraftThreads } from "../lib/mobileDraftThread";
import { clearMobileSelectedThreadForAuthority } from "../lib/mobileHostSelection";
import { forgetRenewedMobileDrafts } from "../lib/mobileHostRenewal";

/** Persist the explicit removal before any scoped data cleanup; preserve other hosts. */
export function forgetMobileHostConnection(input: {
  readonly selected: MobileHostEntry | null;
  readonly legacyStored: StoredMobileSession | null;
  readonly forgetHost: (authorityId: string, dropLegacy: boolean) => boolean;
  readonly forgetLegacy: () => boolean;
  readonly onPersisted: () => void;
  readonly onLegacyCleared: () => void;
  readonly reportIssue: (message: string) => void;
}): boolean {
  const { selected, legacyStored } = input;
  const dropLegacy =
    !selected ||
    (legacyStored?.backendBaseUrl === selected.backendOrigin &&
      legacyStored.sessionId === selected.session.sessionId);
  if (
    selected
      ? !input.forgetHost(selected.pin.authority.authorityId, dropLegacy)
      : !input.forgetLegacy()
  )
    return false;
  input.onPersisted();
  let cleared = true;
  if (selected) {
    cleared = forgetRenewedMobileDrafts(selected);
    cleared =
      clearMobileDraftThreads({
        backendBaseUrl: selected.backendOrigin,
        sessionId: selected.session.sessionId,
        authorityId: selected.pin.authority.authorityId,
      }) && cleared;
    cleared = clearMobileSelectedThreadForAuthority(selected.pin.authority.authorityId) && cleared;
  }
  if (!selected && legacyStored) {
    cleared =
      clearMobileDraftThreads({
        backendBaseUrl: legacyStored.backendBaseUrl,
        sessionId: legacyStored.sessionId,
      }) && cleared;
  }
  if (dropLegacy) {
    try {
      clearMobileSession();
    } catch {
      input.reportIssue(
        "The selected host was left, but browser storage could not remove its previous credential. Retry before reusing that connection.",
      );
      return false;
    }
    input.onLegacyCleared();
  }
  if (!cleared)
    input.reportIssue(
      "The connection was forgotten, but some local drafts could not be removed. Reload saved hosts before continuing.",
    );
  return true;
}
