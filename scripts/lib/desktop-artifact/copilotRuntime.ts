import { Effect } from "effect";
import Path from "node:path";
import {
  assertCopilotRuntimePackaging,
  pruneCopilotRuntimePackages,
  writeCopilotPackagingManifest,
  type CopilotPackagingMode,
} from "../../../apps/desktop/scripts/copilotRuntimePackaging.cjs";
import { BuildScriptError } from "./shared.ts";

/** Keep staging and the final afterPack guard on exactly the same persisted rollout policy. */
export const stageCopilotRuntimePackaging = Effect.fn("stageCopilotRuntimePackaging")(function* (
  serverDirectory: string,
  mode: CopilotPackagingMode,
  targets: readonly string[],
) {
  yield* Effect.try({
    try: () => {
      pruneCopilotRuntimePackages(Path.join(serverDirectory, "node_modules"), mode, targets);
      writeCopilotPackagingManifest(serverDirectory, mode, targets);
      assertCopilotRuntimePackaging(serverDirectory);
    },
    catch: (cause) =>
      new BuildScriptError({ message: "Copilot runtime packaging policy failed.", cause }),
  });
});
