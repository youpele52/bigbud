import { useMemo } from "react";

import { useFilesPanelStore } from "../../stores/files/filesPanel.store";
import { openedFileRank } from "./SearchPalette.frecency.logic";

/** Recency rank of files opened from bigbud (see `boostOpenedFiles`). */
export function useOpenedFileRank(): ReadonlyMap<string, number> {
  const histories = useFilesPanelStore((state) => state.histories);
  const historyKeys = useFilesPanelStore((state) => state.historyKeys);
  return useMemo(() => openedFileRank(histories, historyKeys), [histories, historyKeys]);
}
