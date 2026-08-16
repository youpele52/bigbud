import { useEffect, useRef, type RefObject } from "react";

interface RestoreFilePreviewScrollInput {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly pathKey: string;
  readonly initialScrollTop?: number | null | undefined;
  readonly disabled: boolean;
}

export function useRestoreFilePreviewScroll({
  containerRef,
  pathKey,
  initialScrollTop,
  disabled,
}: RestoreFilePreviewScrollInput) {
  const restoredPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      disabled ||
      initialScrollTop === null ||
      initialScrollTop === undefined ||
      restoredPathRef.current === pathKey
    ) {
      return;
    }
    restoredPathRef.current = pathKey;
    containerRef.current?.scrollTo({ top: initialScrollTop });
  }, [containerRef, disabled, initialScrollTop, pathKey]);
}
