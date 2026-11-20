import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";

const html = document.documentElement;

function alphaOf(token: string): number {
  const probe = document.createElement("div");
  if (token.startsWith("--")) probe.style.backgroundColor = `var(${token})`;
  else probe.dataset.slot = token;
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  // Chromium serialises colour mixes as `color(srgb r g b / a)` and opaque colours without alpha.
  const alpha =
    /\/\s*([\d.]+)\)$/.exec(color)?.[1] ?? /rgba\([^)]*,\s*([\d.]+)\)$/.exec(color)?.[1];
  return alpha === undefined ? 1 : Number(alpha);
}

describe("window material surfaces", () => {
  afterEach(() => {
    delete html.dataset.desktopShell;
    delete html.dataset.windowMaterial;
    html.classList.remove("dark");
  });

  it("keeps every surface opaque while the material is solid", () => {
    html.dataset.desktopShell = "macos";
    html.dataset.windowMaterial = "solid";
    for (const token of ["--background", "--card", "--popover", "--app-shell-pane-fill"]) {
      expect(alphaOf(token)).toBe(1);
    }
  });

  it("makes the whole app surface translucent while the material is translucent", () => {
    html.dataset.desktopShell = "macos";
    html.dataset.windowMaterial = "translucent";
    for (const dark of [false, true]) {
      html.classList.toggle("dark", dark);
      expect(alphaOf("--background")).toBeCloseTo(dark ? 0.64 : 0.72, 2);
      expect(alphaOf("--app-shell-side-panel-background")).toBeCloseTo(dark ? 0.56 : 0.8, 2);
      expect(alphaOf("--card")).toBeCloseTo(0.4, 2);
      expect(alphaOf("--popover")).toBeCloseTo(0.92, 2);
      expect(alphaOf("--app-shell-pane-fill")).toBe(0);
      expect(alphaOf("--app-shell-header-background")).toBe(0);
      expect(alphaOf("--background-solid")).toBe(1);
    }
  });

  it("keeps switch thumbs solid on their coloured track", () => {
    html.dataset.desktopShell = "macos";
    html.dataset.windowMaterial = "translucent";
    expect(alphaOf("switch-thumb")).toBe(1);
  });
});
