import type { ProjectId, ThreadId } from "@bigbud/contracts";
import {
  SYSTEM_SEARCH_MAX_QUERY_CHARS,
  type SystemSearchMode,
  type SystemSearchTier,
} from "@bigbud/contracts/search/systemSearch.ts";
import { countUnicodeCodePoints } from "@bigbud/shared/String";
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
