import type {
  ServerOpencodeV2ThreadToolsSetupInput,
  ServerOpencodeV2ThreadToolsSetupResult,
} from "@bigbud/contracts/server/server.opencodeV2ThreadToolsSetup";

type Result = ServerOpencodeV2ThreadToolsSetupResult;
export type OpenCodeSetupRequest = (
  input: ServerOpencodeV2ThreadToolsSetupInput,
) => Promise<Result>;

export function isPendingOpenCodeSetup(result: Result) {
  return Boolean(
    result.jobId &&
    result.activationState &&
    [
      "checking",
      "prepared",
      "waiting-for-idle",
      "closing-gate",
      "retiring",
      "publishing",
      "verifying",
    ].includes(result.activationState),
  );
}

export function openCodeSetupPollDelay(result: Result) {
  return Math.max(2000, Math.min(result.retryAfter ?? 2000, 30000));
}

/** Observe one authorized setup attempt. Job readiness is reverified for this chat's Location.
 * Disposal stops observation only; it never cancels another native client's work. */
export function observeOpenCodeSetup(
  request: OpenCodeSetupRequest,
  input: ServerOpencodeV2ThreadToolsSetupInput,
  onResult: (result: Result) => void,
  onError: () => void,
) {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interest: Pick<Result, "jobId" | "interestId"> | undefined;
  const deadline = setTimeout(() => {
    if (!active) return;
    active = false;
    if (timer) clearTimeout(timer);
    onError();
  }, 300000);
  function stop() {
    active = false;
    clearTimeout(deadline);
    if (timer) clearTimeout(timer);
  }
  async function check(next: ServerOpencodeV2ThreadToolsSetupInput) {
    try {
      const reply = await request(next);
      const result = {
        ...reply,
        ...(reply.jobId === interest?.jobId && interest?.interestId
          ? { interestId: interest.interestId }
          : {}),
      };
      interest = result;
      if (!active) return;
      if (
        next.operation === "status" &&
        input.operation !== "status" &&
        input.operation !== "cancel-interest" &&
        result.status === "ready"
      ) {
        // A coalesced global activation job may have verified a different Location.
        void check(input);
        return;
      }
      onResult(result);
      if (isPendingOpenCodeSetup(result)) {
        timer = setTimeout(
          () => void check({ operation: "status", jobId: result.jobId! }),
          openCodeSetupPollDelay(result),
        );
      } else stop();
    } catch {
      if (!active) return;
      stop();
      onError();
    }
  }
  void check(input);
  return stop;
}
