import { Effect, Layer } from "effect";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { OpencodeV2Adapter } from "../../Services/OpencodeV2/Adapter.ts";
import { OpencodeV2ServerManager } from "../../Services/OpencodeV2/ServerManager.ts";
import { makeIsolatedOpencodeV2Adapter } from "./Adapter.execution.ts";
import type { V2IsolatedRuntimeOptions } from "./Runtime.types.ts";

/** Explicit service composition for isolated harnesses; not the public dormant Live layer. */
export function isolatedOpencodeV2AdapterLayer(
  options: Omit<V2IsolatedRuntimeOptions, "manager" | "journal" | "emit">,
) {
  return Layer.effect(
    OpencodeV2Adapter,
    Effect.gen(function* () {
      const manager = yield* OpencodeV2ServerManager;
      const journal = yield* ProviderTurnAdmissions;
      return (yield* makeIsolatedOpencodeV2Adapter({ ...options, manager, journal })).adapter;
    }),
  );
}
