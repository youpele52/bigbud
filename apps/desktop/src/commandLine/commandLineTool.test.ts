import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installDesktopCommandLineTool } from "./commandLineTool";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) FS.rmSync(directory, { recursive: true });
});

/** A packaged layout: `<app>/runtime` plus `<app>/resources/server/dist/bin.mjs`. */
function packagedApp() {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "bb-desktop-cli-"));
  directories.push(root);
  const home = Path.join(root, "home");
  const app = Path.join(root, "app");
  const resourcesPath = Path.join(app, "resources");
  FS.mkdirSync(Path.join(resourcesPath, "server", "dist"), { recursive: true });
  FS.mkdirSync(home);
  FS.writeFileSync(Path.join(resourcesPath, "server", "dist", "bin.mjs"), "");
  const execPath = Path.join(app, "bigbud");
  FS.writeFileSync(execPath, "");
  return { root, home, app, resourcesPath, execPath };
}

describe("desktop command-line tool", () => {
  it("is unavailable in development builds and on platforms that are not yet verified", () => {
    const app = packagedApp();
    const base = { ...app, homeDir: app.home, environment: { PATH: "" } };
    expect(
      installDesktopCommandLineTool({ ...base, isPackaged: false, platform: "darwin" }),
    ).toEqual({ status: "unsupported", reason: "Available in the installed bigbud app." });
    expect(installDesktopCommandLineTool({ ...base, isPackaged: true, platform: "win32" })).toEqual(
      {
        status: "unsupported",
        reason: "Not yet available on this platform.",
      },
    );
    expect(FS.existsSync(Path.join(app.home, ".local"))).toBe(false);
  });

  it("points a packaged macOS or deb launcher at the bundled runtime and server entry", () => {
    const app = packagedApp();
    const result = installDesktopCommandLineTool({
      ...app,
      homeDir: app.home,
      isPackaged: true,
      platform: "darwin",
      environment: { PATH: "/usr/bin" },
    });
    expect(result).toMatchObject({ status: "installed" });
    const script = FS.readFileSync(Path.join(app.home, ".local", "bin", "bigbud"), "utf8");
    expect(script).toContain(
      `exec '${app.execPath}' '${Path.join(app.resourcesPath, "server", "dist", "bin.mjs")}' "$@"`,
    );
  });

  it("uses the stable AppImage file and an APPDIR-relative entry inside an AppImage", () => {
    const app = packagedApp();
    const appImage = Path.join(app.root, "bigbud.AppImage");
    FS.writeFileSync(appImage, "");
    const result = installDesktopCommandLineTool({
      ...app,
      homeDir: app.home,
      isPackaged: true,
      platform: "linux",
      environment: { PATH: "/usr/bin", APPIMAGE: appImage, APPDIR: app.app },
    });
    expect(result).toMatchObject({ status: "installed" });
    const script = FS.readFileSync(Path.join(app.home, ".local", "bin", "bigbud"), "utf8");
    expect(script).toContain(`exec '${appImage}' `);
    const bootstrap = FS.readFileSync(
      Path.join(app.home, ".local", "share", "bigbud", "cli", "bigbud-appimage-bootstrap.mjs"),
      "utf8",
    );
    expect(bootstrap).toContain('"resources/server/dist/bin.mjs"');
  });
});
