import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { TerminalViewportErrorBoundary } from "./TerminalViewportErrorBoundary";
import { createTerminalView } from "./TerminalViewport.view";

const mocks = vi.hoisted(() => ({ throwAddons: false }));
vi.mock("./TerminalViewport.addons", async (importOriginal) => {
  const original = await importOriginal<typeof import("./TerminalViewport.addons")>();
  return {
    ...original,
    attachTerminalAddons: (...args: Parameters<typeof original.attachTerminalAddons>) => {
      if (mocks.throwAddons) throw new Error("addon setup exploded");
      return original.attachTerminalAddons(...args);
    },
  };
});

afterEach(() => {
  mocks.throwAddons = false;
  document.body.innerHTML = "";
});

let shouldThrow = true;
let mounts = 0;
function FlakyView() {
  mounts += 1;
  if (shouldThrow) throw new Error("xterm view exploded");
  return <div>terminal ready</div>;
}

it("contains a crashed view and reloads it without touching its siblings", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  shouldThrow = true;
  mounts = 0;
  const screen = await render(
    <div>
      <span>chat stays mounted</span>
      <TerminalViewportErrorBoundary terminalLabel="Terminal 1">
        <FlakyView />
      </TerminalViewportErrorBoundary>
    </div>,
  );

  await expect.element(screen.getByText("This terminal view stopped unexpectedly.")).toBeVisible();
  await expect.element(screen.getByText("chat stays mounted")).toBeVisible();

  shouldThrow = false;
  const mountsBeforeReload = mounts;
  await page.getByRole("button", { name: "Reload terminal view" }).click();

  await expect.element(screen.getByText("terminal ready")).toBeVisible();
  expect(mounts).toBeGreaterThan(mountsBeforeReload);
});

it("disposes a partially created emulator when view setup throws", () => {
  mocks.throwAddons = true;
  const mount = document.createElement("div");
  mount.style.width = "400px";
  mount.style.height = "200px";
  document.body.append(mount);

  expect(() =>
    createTerminalView({
      mount,
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        terminalGpuAcceleration: "off",
        visible: true,
      } as never,
      threadId: "thread",
      terminalId: "terminal",
      onRendering: () => undefined,
    }),
  ).toThrow("addon setup exploded");
  expect(mount.querySelector(".xterm")).toBeNull();
});
