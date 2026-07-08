import { useEffect, useRef } from "react";

import { readNativeApi } from "~/rpc/nativeApi";

import {
  createDebouncedDirectoryChangeRefresh,
  normalizeDirectoryWatchRoots,
} from "./useDirectoryChangeRefresh.logic";

interface UseDirectoryChangeRefreshInput {
  readonly watchRoots: ReadonlyArray<string>;
  readonly refresh: () => void;
}

export function useDirectoryChangeRefresh({ watchRoots, refresh }: UseDirectoryChangeRefreshInput) {
  const normalizedWatchRoots = normalizeDirectoryWatchRoots(watchRoots);
  const watchRootsKey = normalizedWatchRoots.join("\u0000");
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const watchRootsRef = useRef(normalizedWatchRoots);
  watchRootsRef.current = normalizedWatchRoots;

  const debouncedRefreshRef = useRef(
    createDebouncedDirectoryChangeRefresh(() => {
      refreshRef.current();
    }),
  );

  useEffect(() => {
    debouncedRefreshRef.current = createDebouncedDirectoryChangeRefresh(() => {
      refreshRef.current();
    });
  }, [refresh]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      return;
    }

    const scheduleRefresh = () => {
      debouncedRefreshRef.current.schedule();
    };

    const unsubscribe = watchRootsRef.current.map((cwd) =>
      api.projects.onDirectoryChange({ cwd }, scheduleRefresh, {
        onResubscribe: scheduleRefresh,
      }),
    );

    return () => {
      debouncedRefreshRef.current.cancel();
      for (const stopWatching of unsubscribe) {
        stopWatching();
      }
    };
  }, [watchRootsKey]);
}
