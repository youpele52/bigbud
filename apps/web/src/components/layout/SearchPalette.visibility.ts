import { useCallback, useEffect, useState } from "react";

/**
 * Per-section "See more" counts, reset whenever `resetKey` changes (a new query or reopening).
 * One record replaces a `useState` per section.
 */
export function useSectionVisibility(resetKey: string, pageSize: number) {
  const [counts, setCounts] = useState<Readonly<Record<string, number>>>({});
  useEffect(() => {
    setCounts({});
  }, [resetKey]);
  const slice = useCallback(
    <Row>(sectionId: string, rows: readonly Row[]): Row[] =>
      rows.slice(0, counts[sectionId] ?? pageSize),
    [counts, pageSize],
  );
  const showMore = useCallback(
    (sectionId: string) =>
      setCounts((current) => ({
        ...current,
        [sectionId]: (current[sectionId] ?? pageSize) + pageSize,
      })),
    [pageSize],
  );
  return { slice, showMore };
}

export type SectionVisibility = ReturnType<typeof useSectionVisibility>;
