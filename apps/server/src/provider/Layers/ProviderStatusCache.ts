import type { ThreadId } from "@bigbud/contracts";
import { Effect, Layer, Ref } from "effect";

import { ProviderStatusCache, type ProviderStatusEntry } from "../Services/ProviderStatusCache.ts";

export const ProviderStatusCacheLive = Layer.effect(
  ProviderStatusCache,
  Effect.gen(function* () {
    const cache = yield* Ref.make(new Map<ThreadId, ProviderStatusEntry>());

    return {
      get: (threadId: ThreadId) => Ref.get(cache).pipe(Effect.map((m) => m.get(threadId))),
      set: (threadId: ThreadId, entry: ProviderStatusEntry) =>
        Ref.update(cache, (m) => new Map(m).set(threadId, entry)),
      delete: (threadId: ThreadId) =>
        Ref.update(cache, (m) => {
          const next = new Map(m);
          next.delete(threadId);
          return next;
        }),
    };
  }),
);
