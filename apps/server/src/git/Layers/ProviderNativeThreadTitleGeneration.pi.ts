import { TextGenerationError, type PiModelSelection } from "@bigbud/contracts";
import { Effect } from "effect";
import type { ThreadTitleGenerationInput } from "../Services/TextGeneration.ts";
import type { NativeThreadTitleGenerationDeps } from "./ProviderNativeThreadTitleGeneration.ts";

/** Never start Pi with its implicit default: unattended exact-model execution is unsupported. */
export const generatePiThreadTitleNative = (
  _deps: NativeThreadTitleGenerationDeps,
  _input: Omit<ThreadTitleGenerationInput, "modelSelection"> & {
    readonly modelSelection: PiModelSelection;
  },
) =>
  Effect.fail(
    new TextGenerationError({
      operation: "generateThreadTitle",
      kind: "provider",
      detail:
        "Pi unattended title generation cannot guarantee the selected provider/model; this candidate is unsupported.",
    }),
  );
