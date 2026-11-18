import { useLayoutEffect, useRef } from "react";

/** Commit-owned request lease survives StrictMode replay and fences replaced forms. */
export function useMobileRequestOwner(binding: unknown) {
  const owner = useRef<{ active: boolean; request: AbortController | null }>({
    active: false,
    request: null,
  });
  useLayoutEffect(() => {
    const lease: typeof owner.current = { active: true, request: null };
    owner.current = lease;
    return () => {
      lease.active = false;
      lease.request?.abort();
    };
  }, [binding]);
  return owner;
}
