// Run inside the isolated parity container with existing Linux dependencies and Xvfb.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { _electron } from "../../../web/node_modules/playwright/index.mjs";
import { parityReferencePlugin } from "./parity-reference.server.mjs";
import { captureRuntimeIsolation } from "./runtime-isolation.capture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const uiSource = fileURLToPath(new URL("../../../../packages/ui/src", import.meta.url));
const requireDesktop = createRequire(new URL("../../../desktop/package.json", import.meta.url));
const temporary = await mkdtemp("/tmp/bigbud-mobile-parity-electron-");
await mkdir(`${temporary}/profile`);
const workspaceAliases = process.env.MOBILE_PARITY_ALIASES_PATH
  ? JSON.parse(await readFile(process.env.MOBILE_PARITY_ALIASES_PATH, "utf8"))
  : [];
for (const alias of workspaceAliases) {
  if (
    typeof alias.find !== "string" ||
    !alias.find.startsWith("@bigbud/") ||
    typeof alias.replacement !== "string" ||
    !alias.replacement.startsWith("/parity/src/packages/") ||
    alias.replacement.includes("..")
  )
    throw new Error("Invalid parity workspace alias");
}
const entry = `${temporary}/main.cjs`;
await writeFile(
  entry,
  `const { app, BrowserWindow } = require("electron");
app.setPath("userData", ${JSON.stringify(`${temporary}/profile`)});
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1000, height: 900, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
`,
);
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  configLoader: "runner",
  cacheDir: `${temporary}/vite-cache`,
  plugins: [
    parityReferencePlugin({
      route: "/__mobile-runtime-isolation",
      entry: "/tests/browser/runtime-isolation.entry.mjs",
    }),
  ],
  resolve: {
    alias: [...workspaceAliases, { find: "@bigbud/ui", replacement: uiSource }],
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
  optimizeDeps: { entries: ["tests/browser/runtime-isolation.entry.mjs"] },
  server: { host: "127.0.0.1", port: 15746, strictPort: true, hmr: false },
});
let application;
const electronEnvironment = { ...process.env };
delete electronEnvironment.ELECTRON_RUN_AS_NODE;
try {
  await server.listen();
  application = await _electron.launch({
    executablePath: requireDesktop("electron"),
    args: ["--no-sandbox", "--disable-gpu", entry],
    env: electronEnvironment,
  });
  const page = await application.firstWindow();
  const result = await captureRuntimeIsolation(page, "http://127.0.0.1:15746");
  console.log(
    JSON.stringify({
      observations: result.observations.length,
      requests: result.requests,
      errors: result.errors,
    }),
  );
} finally {
  await application?.close();
  await server.close();
}
