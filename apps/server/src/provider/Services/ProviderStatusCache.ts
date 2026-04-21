import type { ProviderKind, ThreadId } from "@bigbud/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface ProviderStatusEntry {
  readonly providerName: ProviderKind;
  readonly status: "initializing" | "ready" | "running" | "closed" | "stopped" | "error";
  readonly updatedAt: string;
}

export interface ProviderStatusCacheShape {
  readonly get: (threadId: ThreadId) => Effect.Effect<ProviderStatusEntry | undefined>;
  readonly set: (threadId: ThreadId, entry: ProviderStatusEntry) => Effect.Effect<void>;
  readonly delete: (threadId: ThreadId) => Effect.Effect<void>;
}

export class ProviderStatusCache extends ServiceMap.Service<
  ProviderStatusCache,
  ProviderStatusCacheShape
>()("t3/provider/Services/ProviderStatusCache") {}
