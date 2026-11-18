// Existing disposable Linux Electron only; no host profile, tools, account or published port.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { parityReferencePlugin } from "./parity-reference.server.mjs";
import { launchMatrixElectron } from "./baseline-matrix.electron.mjs";
import { captureMobileHostAccess } from "./mobile-host-access.capture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp("/tmp/bigbud-mobile-host-access-");
const aliases = JSON.parse(await readFile(process.env.MOBILE_PARITY_ALIASES_PATH, "utf8"));
for (const alias of aliases) {
  if (
    typeof alias.find !== "string" ||
    !alias.find.startsWith("@bigbud/") ||
    typeof alias.replacement !== "string" ||
    !alias.replacement.startsWith("/parity/src/packages/") ||
    alias.replacement.includes("..")
  )
    throw new Error("Invalid host access fixture alias");
}
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  configLoader: "runner",
  cacheDir: `${temporary}/vite-cache`,
  plugins: [
    parityReferencePlugin({
      route: "/__mobile-host-access",
      entry: "/tests/browser/mobile-host-access.entry.mjs",
    }),
  ],
  resolve: { alias: aliases, dedupe: ["react", "react-dom", "@tanstack/react-query"] },
  optimizeDeps: { entries: ["tests/browser/mobile-host-access.entry.mjs"] },
  server: { host: "127.0.0.1", port: 15749, strictPort: true, hmr: false },
});
let browser;
try {
  await server.listen();
  const data = await server.ssrLoadModule("/src/test-fixtures/MobileHostAccess.data.ts");
  browser = await launchMatrixElectron();
  const mode = process.env.MOBILE_HOST_ACCESS_SURFACES;
  if (mode !== undefined && !["controls", "resume", "renewal"].includes(mode))
    throw new Error("Unknown host-access fixture surfaces");
  const capture =
    mode === "controls"
      ? (await import("./mobile-host-controls.capture.mjs")).captureMobileHostControls
      : mode === "resume"
        ? (await import("./mobile-host-resume.capture.mjs")).captureMobileHostResume
        : mode === "renewal"
          ? (await import("./mobile-host-renewal.capture.mjs")).captureMobileHostRenewal
          : captureMobileHostAccess;
  const result = await capture(browser, "http://127.0.0.1:15749", data);
  await writeFile(
    "/parity/results/result-summary.json",
    JSON.stringify(
      {
        directory: result.directory,
        cases: result.results.map((entry) => ({ name: entry.name, status: entry.status })),
        qualification: result.qualification,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      cases: result.results.length,
      status: "passed",
      qualification: result.qualification,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
