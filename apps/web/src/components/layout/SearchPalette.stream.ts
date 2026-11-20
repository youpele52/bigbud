import type { ProjectId, ThreadId } from "@bigbud/contracts";
import {
  SYSTEM_SEARCH_MAX_QUERY_CHARS,
  type SystemSearchMode,
  type SystemSearchTier,
} from "@bigbud/contracts/search/systemSearch.ts";
import { countUnicodeCodePoints } from "@bigbud/shared/String";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useCallback, useEffect, useMemo, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/rpc/nativeApi";
import {
  createSystemSearchRunner,
  EMPTY_SYSTEM_SEARCH_VIEW,
  nextSystemSearchPage,
  systemSearchTiersFor,
  type SystemSearchView,
} from "./SearchPalette.systemSearch.logic";

/** Slow tiers (other projects, this computer, remotes) start after this long without typing. */
export const SLOW_TIER_DEBOUNCE_MS = 150;

/**
 * The query both palettes give their slow tiers: the typed query once typing pauses for
 * {@link SLOW_TIER_DEBOUNCE_MS}, and "" at once when the query is cleared. Fast tiers use the
 * typed query directly, so they are never held back behind this debounce.
 */
export function useSlowTierQuery(query: string): {
  readonly query: string;
  readonly pending: boolean;
} {
  const [slowQuery, debouncer] = useDebouncedValue(
    query,
    { wait: SLOW_TIER_DEBOUNCE_MS },
    (state) => ({ isPending: state.isPending }),
  );
  return { query: query.length > 0 ? slowQuery : "", pending: debouncer.state.isPending };
}

export interface SystemSearchStream {
  readonly view: SystemSearchView;
  /** True when the tier has another page to ask for (only after its query settled). */
  readonly hasMore: (tier: SystemSearchTier) => boolean;
  /** Asks for the tier's next page (on scroll); a no-op when there is none. */
  readonly loadMore: (tier: SystemSearchTier) => void;
}

/**
 * The `search.query` subscription for a palette (Mod+F: T2, T4, T5, T6; Mod+P: file names).
 * Every new query, a next page, a closed palette or an unmount aborts the previous query, which
 * cancels its agent work end to end, so at most one query is live per palette.
 */
export function useSystemSearchStream(input: {
  readonly open: boolean;
  /** Already debounced and normalised. */
  readonly query: string;
  readonly currentProjectId: ProjectId | null;
  readonly currentThreadId: ThreadId | null;
  /** The effective "Search this computer" (on, and File Access is not "No access"). */
  readonly thisComputer: boolean;
  /** Ask for the current project too (Mod+P skips it when its local list answers). */
  readonly currentProject?: boolean;
  /** Ask for the slow tiers too (Mod+F asks for them in a separate, debounced stream). */
  readonly slowTiers?: boolean;
  readonly mode?: SystemSearchMode;
}): SystemSearchStream {
  const [view, setView] = useState<SystemSearchView>(EMPTY_SYSTEM_SEARCH_VIEW);
  const runner = useMemo(() => {
    const api = readNativeApi();
    return api ? createSystemSearchRunner(api.search.query, setView, randomUUID) : null;
  }, []);
  const query = input.query.trim();
  const tiers = systemSearchTiersFor(query, {
    thisComputer: input.thisComputer,
    ...(input.currentProject === false ? { currentProject: false } : {}),
    ...(input.slowTiers === false ? { slowTiers: false } : {}),
  });
  const tiersKey = tiers.join(",");
  const usable =
    input.open &&
    tiers.length > 0 &&
    countUnicodeCodePoints(query) <= SYSTEM_SEARCH_MAX_QUERY_CHARS;
  const shared = useMemo(
    () => ({
      query,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.currentProjectId ? { currentProjectId: input.currentProjectId } : {}),
      ...(input.currentThreadId ? { currentThreadId: input.currentThreadId } : {}),
    }),
    [query, input.mode, input.currentProjectId, input.currentThreadId],
  );

  useEffect(() => {
    runner?.run(usable ? { ...shared, tiers: tiersKey.split(",") as SystemSearchTier[] } : null);
  }, [runner, usable, shared, tiersKey]);
  useEffect(() => () => runner?.cancel(), [runner]);

  const hasMore = useCallback(
    (tier: SystemSearchTier) => usable && nextSystemSearchPage(view, tier) !== null,
    [usable, view],
  );
  const loadMore = useCallback(
    (tier: SystemSearchTier) => {
      const page = usable ? nextSystemSearchPage(view, tier) : null;
      if (page !== null) runner?.more({ ...shared, page }, tier);
    },
    [runner, usable, shared, view],
  );
  return { view, hasMore, loadMore };
}
