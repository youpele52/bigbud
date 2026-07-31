import type { ProviderKind } from "@bigbud/contracts";
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "./Errors.ts";
import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

export type ProviderToolInjectionMode = "builtin-override" | "mcp" | "custom-tools";
export type ProviderCompactionBehavior = "signaled" | "silent" | "none" | "unknown";
export type ProviderTokenUsageSemantics = "current-context" | "cumulative-only" | "unavailable";
export type ProviderSessionHistorySemantics = "persistent" | "bounded" | "turn-local" | "unknown";

export interface ProviderCapabilities {
  readonly supportsRemoteProviderRuntime: boolean;
  readonly supportsLocalRuntimeRemoteWorkspace: boolean;
  readonly toolInjectionMode: ProviderToolInjectionMode;
  readonly needsBuiltinsDisabled: boolean;
  readonly compactionBehavior?: ProviderCompactionBehavior;
  readonly tokenUsageSemantics?: ProviderTokenUsageSemantics;
  readonly sessionHistorySemantics?: ProviderSessionHistorySemantics;
}

export interface ProviderRegistration {
  readonly provider: ProviderKind;
  readonly service: ServerProviderShape;
}

export interface AdapterRegistration {
  readonly provider: ProviderKind;
  readonly service: ProviderAdapterShape<ProviderAdapterError>;
}

export interface OptionalProviderRegistration {
  readonly provider: ProviderKind;
  readonly providerService: ServerProviderShape;
  readonly adapterService: ProviderAdapterShape<ProviderAdapterError>;
  readonly capabilities: ProviderCapabilities;
}

export class OptionalProviderRegistrations extends ServiceMap.Service<
  OptionalProviderRegistrations,
  ReadonlyArray<OptionalProviderRegistration>
>()("bigbud/provider/OptionalProviderRegistrations") {}
