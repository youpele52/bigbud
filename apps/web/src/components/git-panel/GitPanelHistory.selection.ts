import { useCallback, useEffect, useRef, useState } from "react";

/** Keyboard moves through the list settle for this long before details are fetched. */
export const KEYBOARD_DETAILS_DELAY_MS = 150;

export type CommitSelectionSource = "pointer" | "keyboard";

/**
 * The highlighted commit changes immediately; the commit whose details are fetched follows it
 * at once for pointer selection and after `KEYBOARD_DETAILS_DELAY_MS` of quiet for keyboard
 * navigation, so holding an arrow key fetches only the commit the user stops on.
 */
export function useCommitSelection() {
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detailsSha, setDetailsSha] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const select = useCallback((sha: string | null, source: CommitSelectionSource = "pointer") => {
    cancel();
    setSelectedSha(sha);
    if (source === "keyboard" && sha !== null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        setDetailsSha(sha);
      }, KEYBOARD_DETAILS_DELAY_MS);
    } else {
      setDetailsSha(sha);
    }
  }, []);

  useEffect(() => cancel, []);

  return { selectedSha, detailsSha, select };
}
