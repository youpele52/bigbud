import { useCallback, useLayoutEffect, useState } from "react";

/** A dialog opened for one draft never follows the user to another draft. */
export function useComposerReadDialogState(threadId: string) {
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  useLayoutEffect(() => {
    setOpenedFor(null);
  }, [threadId]);
  const setReadDocumentDialogOpen = useCallback(
    (open: boolean) => setOpenedFor(open ? threadId : null),
    [threadId],
  );
  return {
    readDocumentDialogOpen: openedFor === threadId,
    setReadDocumentDialogOpen,
  };
}
