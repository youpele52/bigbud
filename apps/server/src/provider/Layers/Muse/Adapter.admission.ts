import { createHash } from "node:crypto";

/** Fingerprint of the exact expanded input, model/effort and effective safety policy. */
export function museTurnFingerprint(input: {
  readonly text: string;
  readonly model: string;
  readonly effort?: string;
  readonly runtimeMode: string;
  readonly nativeSessionId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        text: input.text,
        model: input.model,
        effort: input.effort ?? null,
        runtimeMode: input.runtimeMode,
        nativeSessionId: input.nativeSessionId,
        profile: ":ask-me",
        approvalMode: "promptUnmatched",
      }),
    )
    .digest("hex");
}
