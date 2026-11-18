import type { MobileGatewayAttempt } from "./mobileGatewayLifecycle.schema.ts";

/** Native rows never become Node-child rows or accept Node-handle/no-launch evidence. */
export function validateMobileNativeGatewayAttempt(attempt: MobileGatewayAttempt): void {
  const original = attempt.nativeOwnership;
  const kind = attempt.completionEvidence?.kind;
  const nativeCompletion =
    kind === "native-exit" ||
    kind === "native-cancel" ||
    kind === "native-never-invoked" ||
    kind === "native-epoch-ended";
  if (!original) {
    if (nativeCompletion || attempt.currentController)
      throw Error("Native terminal evidence requires original native ownership.");
    return;
  }
  const adopted = attempt.currentController;
  if (
    !/^start-v2:linux:[^:]{1,64}:[0-9]{1,32}$/.test(attempt.controller.startedAt) ||
    original.binding.nonce !== attempt.nonce ||
    original.binding.nativeEpoch !== attempt.binding.epoch ||
    original.binding.publicationSha256 !== attempt.releaseId.slice("mobile-release:".length) ||
    (adopted !== undefined && !/^start-v2:linux:[^:]{1,64}:[0-9]{1,32}$/.test(adopted.startedAt)) ||
    (attempt.completionEvidence?.kind === "native-epoch-ended" &&
      attempt.completionEvidence.epoch !== original.binding.nativeEpoch) ||
    attempt.child ||
    attempt.phase === "child-owned" ||
    (attempt.phase === "exit-confirmed") !== nativeCompletion
  )
    throw Error("Native gateway identity/child/terminal fence differs from original ownership.");
}
