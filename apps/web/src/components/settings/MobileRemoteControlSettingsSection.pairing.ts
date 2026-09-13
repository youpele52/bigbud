import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ensureNativeApi } from "../../rpc/nativeApi";
import {
  normalizeBackendBaseUrl,
  resolveSelectedMobileWebUrl,
  resolveStoredMobileWebSelection,
  type MobileWebUrlSelection,
} from "./mobileRemoteControl.urls";
import {
  MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY,
  MOBILE_WEB_BASE_URL_STORAGE_KEY,
} from "./MobileRemoteControlSettingsSection.status";
import { mobileDevDiscoveryQueryOptions } from "./MobileRemoteControlSettingsSection.discovery";

export const MOBILE_WEB_SELECTION_STORAGE_KEY = "bigbud:mobile-web:selection:v1";

export function readStoredMobileWebSelection(): MobileWebUrlSelection {
  return resolveStoredMobileWebSelection(
    typeof window === "undefined"
      ? null
      : window.localStorage.getItem(MOBILE_WEB_SELECTION_STORAGE_KEY),
    typeof window === "undefined"
      ? null
      : window.localStorage.getItem(MOBILE_WEB_BASE_URL_STORAGE_KEY),
    import.meta.env.DEV,
  );
}

export function useMobileRemotePairing(backendBaseUrl: string) {
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState(readStoredMobileWebSelection);
  useEffect(() => {
    window.localStorage.setItem(MOBILE_WEB_SELECTION_STORAGE_KEY, JSON.stringify(selection));
  }, [selection]);
  const discovery = useQuery({
    ...mobileDevDiscoveryQueryOptions(),
    enabled: import.meta.env.DEV && selection.mode === "local",
  });
  const liveUrl = selection.mode !== "local" || discovery.isError ? null : (discovery.data ?? null);
  const mobileBaseUrl = resolveSelectedMobileWebUrl(selection, liveUrl);
  const selectionKey = JSON.stringify([selection, normalizeBackendBaseUrl(backendBaseUrl)]);
  const contextKey = JSON.stringify([selectionKey, mobileBaseUrl]);
  const generation = useRef(0);
  const liveEndpoint = useRef({ url: liveUrl, revision: 0 });
  const [result, setResult] = useState<{
    contextKey: string;
    link: string | null;
    error: string | null;
  } | null>(null);

  useLayoutEffect(() => {
    generation.current += 1;
    setResult(null);
    return () => {
      generation.current += 1;
    };
  }, [selectionKey]);

  const trackLiveEndpoint = useCallback(
    (url: string | null) => {
      if (liveEndpoint.current.url !== url) {
        liveEndpoint.current = { url, revision: liveEndpoint.current.revision + 1 };
        if (selection.mode === "local") setResult(null);
      }
    },
    [selection.mode],
  );
  useLayoutEffect(() => {
    trackLiveEndpoint(liveUrl);
  }, [liveUrl, trackLiveEndpoint]);

  const updateSelection = (next: MobileWebUrlSelection) => {
    generation.current += 1;
    setResult(null);
    setSelection(next);
  };

  const createPairingMutation = useMutation({
    mutationFn: async () => {
      const startGeneration = generation.current;
      let nextMobileBaseUrl = mobileBaseUrl;
      if (selection.mode === "local") {
        // Cancel polling so this request always verifies the listener immediately before pairing.
        await queryClient.cancelQueries({ queryKey: mobileDevDiscoveryQueryOptions().queryKey });
        nextMobileBaseUrl = await queryClient.fetchQuery(mobileDevDiscoveryQueryOptions());
        if (generation.current !== startGeneration) return null;
        trackLiveEndpoint(nextMobileBaseUrl);
      }
      const liveRevision = liveEndpoint.current.revision;
      const isCurrent = () =>
        generation.current === startGeneration &&
        (selection.mode !== "local" ||
          (liveEndpoint.current.revision === liveRevision &&
            queryClient.getQueryData(mobileDevDiscoveryQueryOptions().queryKey) ===
              nextMobileBaseUrl));
      const resultContextKey = JSON.stringify([selectionKey, nextMobileBaseUrl]);
      try {
        if (!nextMobileBaseUrl)
          throw new Error("The local mobile app is unavailable. Start it before pairing.");
        const nextBackendBaseUrl = normalizeBackendBaseUrl(backendBaseUrl);
        window.localStorage.setItem(MOBILE_REMOTE_BACKEND_URL_STORAGE_KEY, nextBackendBaseUrl);
        const pairing = await ensureNativeApi().server.createMobileRemotePairing({
          scope: "thread-control",
          baseUrl: nextMobileBaseUrl,
          backendBaseUrl: nextBackendBaseUrl,
        });
        return isCurrent()
          ? { contextKey: resultContextKey, link: pairing.pairUrl, error: null }
          : null;
      } catch (error) {
        return isCurrent()
          ? {
              contextKey: resultContextKey,
              link: null,
              error: error instanceof Error ? error.message : String(error),
            }
          : null;
      }
    },
    onSuccess: (nextResult) => {
      if (nextResult) setResult(nextResult);
    },
  });

  return {
    selection,
    updateSelection,
    mobileBaseUrl,
    liveUrl,
    isDiscovering: discovery.isLoading,
    pairingLink: result?.contextKey === contextKey ? result.link : null,
    pairingError: result?.contextKey === contextKey ? result.error : null,
    isPairing: createPairingMutation.isPending,
    createPairing: () => {
      setResult(null);
      createPairingMutation.mutate();
    },
  };
}
