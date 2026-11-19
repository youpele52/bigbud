/**
 * Mod+F workspace-wide search (`search.query`, system-wide search plan §4). UI-only: results are
 * never handed to thread tools, MCP bridges, provider adapters or automations.
 */
import { ServiceMap } from "effect";
import type { Stream } from "effect";

import type {
  SystemSearchError,
  SystemSearchQueryInput,
  SystemSearchTierUpdate,
} from "@bigbud/contracts/search/systemSearch.ts";

export interface SystemSearchShape {
  /** A finite stream of tier updates; interrupting it cancels every agent operation it started. */
  readonly query: (
    input: SystemSearchQueryInput,
  ) => Stream.Stream<SystemSearchTierUpdate, SystemSearchError>;
}

export class SystemSearch extends ServiceMap.Service<SystemSearch, SystemSearchShape>()(
  "bigbud/search/Services/SystemSearch",
) {}
