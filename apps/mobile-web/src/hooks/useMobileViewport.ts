import { useEffect } from "react";

import { resolveMobileViewport } from "../logic/mobileViewport.logic";

/** Resize the shell without replacing the focused editor or updating conversation state. */
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const style = document.documentElement.style;
    const properties = ["--mobile-viewport-height", "--mobile-viewport-top"] as const;
    const previous = properties.map((name) => ({
      name,
      value: style.getPropertyValue(name),
      priority: style.getPropertyPriority(name),
    }));
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const geometry = resolveMobileViewport(viewport, window.innerHeight);
      if (!geometry) return;
      style.setProperty(properties[0], `${geometry.height}px`);
      style.setProperty(properties[1], `${geometry.top}px`);
    };
    const schedule = () => {
      frame ??= window.requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("pageshow", schedule);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("pageshow", schedule);
      for (const { name, value, priority } of previous) {
        if (value) style.setProperty(name, value, priority);
        else style.removeProperty(name);
      }
    };
  }, []);
}
