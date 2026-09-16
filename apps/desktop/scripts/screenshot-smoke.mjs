import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const outputDir = mkdtempSync(join(tmpdir(), "bigbud-screenshot-smoke-"));
const require = createRequire(import.meta.url);

try {
  const build = spawnSync(
    "bun",
    [
      "build",
      "src/window/desktopScreenshot.smoke.ts",
      "src/preload.ts",
      "--root",
      "src",
      "--target=node",
      "--format=cjs",
      "--external",
      "electron",
      "--entry-naming",
      "[dir]/[name].cjs",
      "--outdir",
      outputDir,
    ],
    { cwd: desktopDir, stdio: "inherit" },
  );
  if (build.status !== 0) throw build.error ?? new Error("Screenshot smoke build failed.");

  const env = { ...process.env, BIGBUD_SCREENSHOT_SMOKE_DIR: outputDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(
    require("electron"),
    [join(outputDir, "window/desktopScreenshot.smoke.cjs")],
    { env, stdio: "inherit", timeout: 60_000 },
  );
  if (run.status !== 0) throw run.error ?? new Error("Native screenshot smoke failed.");
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
