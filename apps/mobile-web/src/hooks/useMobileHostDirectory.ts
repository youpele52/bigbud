import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MOBILE_HOST_DIRECTORY_STORAGE_KEY,
  readMobileHostDirectory,
  writeMobileHostDirectory,
  type MobileHostDirectoryEntry,
} from "../lib/mobileHostDirectory";

function read() {
  try {
    return readMobileHostDirectory(window.localStorage);
  } catch {
    return { ok: false } as const;
  }
}
export function useMobileHostDirectory() {
  const [state, setState] = useState(read);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === MOBILE_HOST_DIRECTORY_STORAGE_KEY || event.key === null) setState(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const remember = useCallback((entry: MobileHostDirectoryEntry) => {
    const current = read();
    if (!current.ok) return false;
    const old = current.entries.find((saved) => saved.backendOrigin === entry.backendOrigin);
    if (old?.authorityId && entry.authorityId && old.authorityId !== entry.authorityId)
      return false;
    const entries = [
      ...current.entries.filter((saved) => saved.backendOrigin !== entry.backendOrigin),
      { ...old, ...entry },
    ];
    try {
      if (!writeMobileHostDirectory(window.localStorage, entries)) return false;
      setState(read());
      return true;
    } catch {
      return false;
    }
  }, []);
  const forget = useCallback((backendOrigin: string) => {
    const current = read();
    if (!current.ok) return false;
    try {
      if (
        !writeMobileHostDirectory(
          window.localStorage,
          current.entries.filter((entry) => entry.backendOrigin !== backendOrigin),
        )
      )
        return false;
      setState(read());
      return true;
    } catch {
      return false;
    }
  }, []);
  return useMemo(() => ({ state, remember, forget }), [state, remember, forget]);
}
