import { describe, expect, it, vi } from "vitest";

import { syncWindowZoomCssVariable, WINDOW_ZOOM_CSS_VARIABLE } from "./useWindowZoomCssVariable";

const fakeRoot = () => {
  const values = new Map<string, string>();
  return {
    values,
    style: {
      setProperty: (name: string, value: string | null) => void values.set(name, value ?? ""),
      removeProperty: (name: string) => {
        const previous = values.get(name) ?? "";
        values.delete(name);
        return previous;
      },
    },
  };
};

describe("syncWindowZoomCssVariable", () => {
  it("applies the current zoom, follows changes, and cleans up", () => {
    let emit: ((zoomFactor: number) => void) | undefined;
    const unsubscribe = vi.fn();
    const root = fakeRoot();

    const cleanup = syncWindowZoomCssVariable(
      {
        getWindowZoomFactor: () => 0.8,
        onWindowZoomFactorChange: (listener) => {
          emit = listener;
          return unsubscribe;
        },
      },
      root,
    );
    expect(root.values.get(WINDOW_ZOOM_CSS_VARIABLE)).toBe("0.8");

    emit?.(1.5);
    expect(root.values.get(WINDOW_ZOOM_CSS_VARIABLE)).toBe("1.5");
    emit?.(Number.NaN);
    expect(root.values.get(WINDOW_ZOOM_CSS_VARIABLE)).toBe("1");

    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(root.values.has(WINDOW_ZOOM_CSS_VARIABLE)).toBe(false);
  });

  it("does nothing without the desktop bridge", () => {
    const root = fakeRoot();
    syncWindowZoomCssVariable(undefined, root)();
    expect(root.values.size).toBe(0);
  });
});
