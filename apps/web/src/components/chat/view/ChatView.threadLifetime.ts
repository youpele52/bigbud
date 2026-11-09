import { useCallback, useEffect, useRef } from "react";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";

/** Capture authority over this mounted surface, not merely a thread ID.
 * Leaving and returning to the same thread must not revive an older callback. */
export function useThreadSurfaceLifetime(threadId: ThreadId | undefined) {
  const lifetime = useRef({ threadId, version: 0, mounted: true });
  if (lifetime.current.threadId !== threadId) {
    lifetime.current = { ...lifetime.current, threadId, version: lifetime.current.version + 1 };
  }
  useEffect(() => {
    lifetime.current.mounted = true;
    return () => {
      lifetime.current.mounted = false;
      lifetime.current.version += 1;
    };
  }, []);
  const surface = lifetime.current;
  return useCallback(() => {
    const version = surface.version;
    return () => lifetime.current === surface && surface.mounted && surface.version === version;
  }, [surface]);
}
