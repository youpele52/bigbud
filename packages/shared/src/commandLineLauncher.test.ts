import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  BIGBUD_LAUNCHER_MARKER,
  buildCommandLineLauncherScript,
  installCommandLineLauncher,
  resolveCommandLineLauncherTarget,
} from "./commandLineLauncher.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) FS.rmSync(directory, { recursive: true });
});

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

function fixture() {
  const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "bb-launcher-"));
  directories.push(home);
  const app = Path.join(home, "app's dir");
  FS.mkdirSync(app);
  const entry = Path.join(app, "bin.mjs");
  // Reports what the CLI sees: its args and whether an eval-scope `__filename` leaked in.
  FS.writeFileSync(
    entry,
    "console.log(JSON.stringify([typeof __filename, process.argv.slice(2)]))\n",
  );
  return {
    home,
    app,
    entry,
    base: {
      platform: "darwin" as const,
      homeDir: home,
      target: { kind: "direct" as const, nodeExecutable: process.execPath, serverEntry: entry },
    },
  };
}

describe("command-line launcher", () => {
  it("creates an executable launcher that forwards arguments to the bundled CLI", () => {
    const { home, base } = fixture();
    const result = installCommandLineLauncher({ ...base, pathValue: "/usr/bin" });
    expect(result).toMatchObject({
      status: "installed",
      pathHint: expect.stringContaining(".local/bin"),
    });
    const launcher = Path.join(home, ".local", "bin", "bigbud");
    expect(FS.statSync(launcher).mode & 0o777).toBe(0o755);
    const run = spawnSync(launcher, ["remote-agent", "status", "a b"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(["undefined", ["remote-agent", "status", "a b"]]);
  });

  it("starts an AppImage's bundled CLI through a real bootstrap file, not node -e", () => {
    const { home, app, base } = fixture();
    // Stand-in for the AppImage runtime: it mounts the app, sets APPDIR and execs the runtime.
    const appImage = Path.join(home, "bigbud.AppImage");
    FS.writeFileSync(
      appImage,
      `#!/bin/sh\nAPPDIR=${quote(app)} exec ${quote(process.execPath)} "$@"\n`,
      { mode: 0o755 },
    );
    const result = installCommandLineLauncher({
      ...base,
      platform: "linux",
      pathValue: "/usr/bin",
      target: { kind: "appimage", appImagePath: appImage, serverEntryInAppDir: "bin.mjs" },
    });
    expect(result.status).toBe("installed");
    const launcher = Path.join(home, ".local", "bin", "bigbud");
    const run = spawnSync(launcher, ["status", "it's two"], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual(["undefined", ["status", "it's two"]]);
    const bootstrap = Path.join(
      home,
      ".local",
      "share",
      "bigbud",
      "cli",
      "bigbud-appimage-bootstrap.mjs",
    );
    FS.writeFileSync(bootstrap, "// someone else's file\n");
    expect(
      installCommandLineLauncher({
        ...base,
        platform: "linux",
        pathValue: "/usr/bin",
        target: { kind: "appimage", appImagePath: appImage, serverEntryInAppDir: "bin.mjs" },
      }).status,
    ).toBe("unsupported");
    expect(FS.readFileSync(bootstrap, "utf8")).toBe("// someone else's file\n");
    FS.rmSync(bootstrap);
    expect(
      installCommandLineLauncher({
        ...base,
        platform: "linux",
        pathValue: "/usr/bin",
        target: { kind: "appimage", appImagePath: appImage, serverEntryInAppDir: "../x.mjs" },
      }).status,
    ).toBe("unsupported");
  });

  it("never replaces another bigbud command and refreshes only its own launcher", () => {
    const { home, base } = fixture();
    const other = Path.join(home, "other");
    FS.mkdirSync(other);
    FS.writeFileSync(Path.join(other, "bigbud"), "#!/bin/sh\n", { mode: 0o755 });
    expect(installCommandLineLauncher({ ...base, pathValue: other })).toEqual({
      status: "existing-command",
      existingPath: Path.join(other, "bigbud"),
    });
    const binDir = Path.join(home, ".local", "bin");
    expect(installCommandLineLauncher({ ...base, pathValue: binDir })).toMatchObject({
      status: "installed",
      pathHint: null,
    });
    expect(installCommandLineLauncher({ ...base, pathValue: binDir }).status).toBe("updated");
    FS.writeFileSync(Path.join(binDir, "bigbud"), "#!/bin/sh\necho mine\n");
    expect(installCommandLineLauncher({ ...base, pathValue: "/usr/bin" }).status).toBe(
      "existing-command",
    );
  });

  it("quotes paths and reports missing bundles", () => {
    const script = buildCommandLineLauncherScript({ runtime: "/A/it's", script: "/B/bin.mjs" });
    expect(script).toContain(BIGBUD_LAUNCHER_MARKER);
    expect(script).toContain(`exec '/A/it'\\''s' '/B/bin.mjs' "$@"`);
    const { base } = fixture();
    expect(
      installCommandLineLauncher({
        ...base,
        target: { ...base.target, serverEntry: "/missing/bin.mjs" },
        pathValue: "",
      }).status,
    ).toBe("unsupported");
  });

  it("detects an AppImage run only when the entry is inside the mounted APPDIR", () => {
    const base = { platform: "linux" as const, runtime: "/tmp/.mount_x/bigbud" };
    const environment = { APPIMAGE: "/home/u/bigbud.AppImage", APPDIR: "/tmp/.mount_x" };
    expect(
      resolveCommandLineLauncherTarget({
        ...base,
        serverEntry: "/tmp/.mount_x/resources/server/dist/bin.mjs",
        environment,
      }),
    ).toEqual({
      kind: "appimage",
      appImagePath: "/home/u/bigbud.AppImage",
      serverEntryInAppDir: "resources/server/dist/bin.mjs",
    });
    for (const [platform, serverEntry, env] of [
      ["linux", "/opt/bigbud/resources/server/dist/bin.mjs", environment],
      ["darwin", "/tmp/.mount_x/resources/server/dist/bin.mjs", environment],
      ["linux", "/tmp/.mount_x/resources/server/dist/bin.mjs", {}],
    ] as const) {
      expect(
        resolveCommandLineLauncherTarget({ ...base, platform, serverEntry, environment: env }),
      ).toEqual({ kind: "direct", nodeExecutable: base.runtime, serverEntry });
    }
  });

  it("gives prerelease channels their own command so they never replace the stable launcher", () => {
    const { home, base } = fixture();
    const binDir = Path.join(home, ".local", "bin");
    expect(installCommandLineLauncher({ ...base, pathValue: binDir }).status).toBe("installed");
    expect(
      installCommandLineLauncher({ ...base, pathValue: binDir, commandName: "bigbud-beta" }),
    ).toMatchObject({ status: "installed", launcherPath: Path.join(binDir, "bigbud-beta") });
    expect(FS.existsSync(Path.join(binDir, "bigbud"))).toBe(true);
    expect(
      installCommandLineLauncher({ ...base, pathValue: binDir, commandName: "rm -rf" }).status,
    ).toBe("unsupported");
  });
});
