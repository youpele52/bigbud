import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { readSettingsScroll, rememberSettingsScroll } from "./settingsLastLocation";

/** The current Settings page path, provided by the Settings layout; null outside it (tests). */
const SettingsPagePathContext = createContext<string | null>(null);

export function SettingsPagePathProvider(props: { path: string; children: ReactNode }) {
  return (
    <SettingsPagePathContext.Provider value={props.path}>
      {props.children}
    </SettingsPagePathContext.Provider>
  );
}

const SAVE_DELAY_MS = 150;

/**
 * Restores a Settings page's saved scroll offset when it opens and saves it while scrolling, so
 * reopening Settings lands on the section the user was looking at.
 */
export function useSettingsScrollMemory(scrollRef: RefObject<HTMLDivElement | null>) {
  const path = useContext(SettingsPagePathContext);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!path || !element) return;
    const saved = readSettingsScroll(path);
    // Rows render synchronously; wait one frame so the page has its full height.
    const frame = saved > 0 ? requestAnimationFrame(() => (element.scrollTop = saved)) : null;
    const onScroll = () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(
        () => rememberSettingsScroll(path, element.scrollTop),
        SAVE_DELAY_MS,
      );
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      element.removeEventListener("scroll", onScroll);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      rememberSettingsScroll(path, element.scrollTop);
    };
  }, [path, scrollRef]);
}
