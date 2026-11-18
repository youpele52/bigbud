// Existing Linux Electron only: disposable profile/partitions, no host browser install.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { _electron } from "../../../web/node_modules/playwright/index.mjs";

export async function launchMatrixElectron() {
  if (process.platform !== "linux") throw new Error("Matrix Electron fixture requires Linux");
  const requireDesktop = createRequire(new URL("../../../desktop/package.json", import.meta.url));
  const temporary = await mkdtemp("/tmp/bigbud-mobile-matrix-electron-");
  await mkdir(`${temporary}/profile`);
  const entry = `${temporary}/main.cjs`;
  await writeFile(
    entry,
    `const { app, BrowserWindow } = require("electron");
app.setPath("userData", ${JSON.stringify(`${temporary}/profile`)});
app.whenReady().then(() => {
  const keeper = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  keeper.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
`,
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({
    executablePath: requireDesktop("electron"),
    args: ["--no-sandbox", "--disable-gpu", entry],
    env: environment,
  });
  await application.firstWindow();
  let counter = 0;
  return {
    async newPage({ viewport, colorScheme, hasTouch }) {
      counter += 1;
      const pending = application.waitForEvent("window");
      await application.evaluate(
        async ({ BrowserWindow }, options) => {
          const window = new BrowserWindow({
            width: options.width,
            height: options.height,
            webPreferences: {
              partition: options.partition,
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
            },
          });
          await window.loadURL("about:blank");
        },
        { ...viewport, partition: `mobile-matrix-${counter}` },
      );
      const page = await pending;
      // Electron's Playwright Clock belongs to its shared context, not a native partition.
      // Previous loading cases deliberately pause it; restore timers before the next case.
      await page.clock.install({ time: Date.now() });
      await page.clock.resume();
      await page.setViewportSize(viewport);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        ...viewport,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: hasTouch === true });
      await page.emulateMedia({ colorScheme });
      return page;
    },
    close: () => application.close(),
  };
}
