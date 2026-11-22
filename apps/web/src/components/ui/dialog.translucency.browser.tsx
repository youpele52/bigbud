import "~/index.css";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { Dialog, DialogPopup, DialogTitle } from "./dialog";

const root = document.documentElement;

afterEach(() => {
  delete root.dataset.desktopShell;
  delete root.dataset.windowMaterial;
});

function alpha(color: string): number {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data[3]! / 255;
}

function appBackground(): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = "var(--background)";
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

it("keeps the window translucent behind an open dialog while the dialog stays solid", async () => {
  root.dataset.desktopShell = "macos";
  root.dataset.windowMaterial = "translucent";
  const before = appBackground();
  expect(alpha(before)).toBeLessThan(1);

  const screen = await render(
    <Dialog open>
      <DialogPopup>
        <DialogTitle>Translucency</DialogTitle>
      </DialogPopup>
    </Dialog>,
  );
  const popup = document.querySelector<HTMLElement>("[data-slot=dialog-popup]")!;
  const backdrop = document.querySelector<HTMLElement>("[data-slot=dialog-backdrop]")!;
  expect(popup).toBeTruthy();
  expect(backdrop).toBeTruthy();

  expect(appBackground()).toBe(before);
  expect(alpha(getComputedStyle(popup).backgroundColor)).toBe(1);
  expect(alpha(getComputedStyle(backdrop).backgroundColor)).toBeLessThan(1);
  await screen.unmount();
});
