import { Effect, Option } from "effect";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";

/** Explicit stop retains native identity without licensing implicit recovery on the next send. */
export const preserveStoppedProviderBinding = Effect.fn("preserveStoppedProviderBinding")(
  function* (directory: ProviderSessionDirectoryShape, threadId: ThreadId) {
    const binding = yield* directory.getBinding(threadId);
    if (Option.isSome(binding) && binding.value.resumeCursor != null)
      yield* directory.upsert({
        ...binding.value,
        status: "stopped",
        runtimePayload: { explicitlyStopped: true },
      });
    else yield* directory.remove(threadId);
  },
);
