import type { V2ActivationHandle, V2ActivationJobStatus } from "./PluginSetup.activation.jobs.ts";

/** Normal setup deferral carries observation handles, never native execution authority. */
export class V2ActivationDeferred extends Error {
  constructor(
    readonly status: V2ActivationJobStatus,
    readonly handle: V2ActivationHandle,
  ) {
    super(
      `V2 automatic setup ${status.state}: ${status.reason ?? "known native work must settle"}. No native history or prompt was admitted; background success never resubmits this request.`,
    );
  }
}

/** Only observed pre-publication busy/race outcomes are retryable within the original job deadline. */
export class V2ActivationBusy extends Error {}
