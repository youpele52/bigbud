import type { ProjectId, ThreadId } from "@bigbud/contracts";
import { SYSTEM_SEARCH_MAX_QUERY_CHARS } from "@bigbud/contracts/search/systemSearch.ts";
import { countUnicodeCodePoints } from "@bigbud/shared/String";
import { useEffect, useMemo, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/rpc/nativeApi";
import {
  createSystemSearchRunner,
  EMPTY_SYSTEM_SEARCH_VIEW,
  systemSearchTiersFor,
  type SystemSearchView,
} from "./SearchPalette.systemSearch.logic";

/**
 * The `search.query` subscription for the palette (T2, T4, T5, T6). Every new query, a closed
 * palette or an unmount aborts the previous query, which cancels its agent work end to end.
 */
export function useSystemSearchStream(input: {
  readonly open: boolean;
  /** Already debounced and normalised. */
  readonly query: string;
  readonly currentProjectId: ProjectId | null;
  readonly currentThreadId: ThreadId | null;
  readonly thisComputer: boolean;
}): SystemSearchView {
  const [view, setView] = useState<SystemSearchView>(EMPTY_SYSTEM_SEARCH_VIEW);
  const runner = useMemo(() => {
    const api = readNativeApi();
    return api ? createSystemSearchRunner(api.search.query, setView, randomUUID) : null;
  }, []);
  const query = input.query.trim();
  const tiers = systemSearchTiersFor(query, { thisComputer: input.thisComputer });
  const tiersKey = tiers.join(",");
  const usable =
    input.open &&
    tiers.length > 0 &&
    countUnicodeCodePoints(query) <= SYSTEM_SEARCH_MAX_QUERY_CHARS;

  useEffect(() => {
    runner?.run(
      usable
        ? {
            query,
            tiers: tiersKey.split(",") as typeof tiers,
            ...(input.currentProjectId ? { currentProjectId: input.currentProjectId } : {}),
            ...(input.currentThreadId ? { currentThreadId: input.currentThreadId } : {}),
          }
        : null,
    );
    // `tiersKey` carries `tiers`; arrays are rebuilt every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [runner, usable, query, tiersKey, input.currentProjectId, input.currentThreadId]);
  useEffect(() => () => runner?.cancel(), [runner]);

  return view;
}
