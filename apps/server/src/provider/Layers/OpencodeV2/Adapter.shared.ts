import { Effect } from "effect";
import { makeV2RuntimeAdapter } from "./Adapter.runtime.ts";
import type { V2IsolatedRuntimeOptions } from "./Runtime.types.ts";
import type { V2SharedProcessConfig } from "./ServerManager.types.ts";

/** The only production V2 entry requires borrowed native topology and required canonical infrastructure. */
export const makeSharedOpencodeV2Adapter = Effect.fn("makeSharedOpencodeV2Adapter")(function* (
  options: Omit<
    V2IsolatedRuntimeOptions<V2SharedProcessConfig>,
    "emit" | "enableIsolatedMcp" | "remoteSessionConformance" | "codingBridge"
  > &
    Required<
      Pick<
        V2IsolatedRuntimeOptions,
        "threadBridge" | "threadToolsPreflight" | "prepareSession" | "sharedBindings" | "consent"
      >
    >,
) {
  if (!options.config.sharedService)
    throw new Error("V2 production requires shared native service.");
  return yield* makeV2RuntimeAdapter(options);
});
