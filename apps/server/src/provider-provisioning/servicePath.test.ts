import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverServicePath, resolveProviderExecutable } from "./servicePath.ts";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(Path.join(tmpdir(), "bigbud-service-path-"));
  home = Path.join(root, "home");
  mkdirSync(home);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeExecutable(path: string, body: string): string {
  mkdirSync(Path.dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

/**
 * A non-interactive "login shell" that, like Ubuntu's bash with nvm in ~/.bashrc, does not load
 * nvm. It refuses to run when it has a terminal on stdin or a controlling TTY.
 */
function fakeShell(name: string, script: string): string {
  return writeExecutable(
    Path.join(root, "shells", name),
    [
      "#!/bin/sh",
      "if [ -t 0 ]; then echo stdin-is-tty; exit 9; fi",
      "if (: < /dev/tty) 2>/dev/null; then echo controlling-tty; exit 9; fi",
      script,
    ].join("\n"),
  );
}

function makeNvmLayout(): void {
  for (const version of ["v20.11.1", "v22.3.0"]) {
    writeExecutable(Path.join(home, ".nvm/versions/node", version, "bin/codex"), "#!/bin/sh\n");
  }
  mkdirSync(Path.join(home, ".nvm/alias"), { recursive: true });
  writeFileSync(Path.join(home, ".nvm/alias/default"), "lts/iron\n");
  mkdirSync(Path.join(home, ".nvm/alias/lts"), { recursive: true });
  writeFileSync(Path.join(home, ".nvm/alias/lts/iron"), "v20.11.1\n");
}

const serviceEnv = () => ({ HOME: home, PATH: "/usr/bin:/bin" });

describe("discoverServicePath", () => {
  it("nvm_shim_found_without_tty", async () => {
    makeNvmLayout();
    const shell = fakeShell("plain", 'PATH=/usr/bin:/bin; export PATH; exec /bin/sh -c "$2"');
    const discovery = await Effect.runPromise(
      discoverServicePath({ env: serviceEnv(), home, shell, platform: "linux" }),
    );
    expect(discovery.shell.status).toBe("captured");
    const resolved = await Effect.runPromise(
      resolveProviderExecutable({ commandNames: ["codex"], discovery }),
    );
    expect(resolved).toMatchObject({
      source: "discovered",
      // nvm's default alias (lts/iron -> v20.11.1) wins over the newest install.
      path: Path.join(home, ".nvm/versions/node/v20.11.1/bin/codex"),
      entry: { source: "versionManager", manager: "nvm" },
    });
  });

  it("explicit_path_preserved", async () => {
    makeNvmLayout();
    const explicitDir = Path.join(root, "explicit-bin");
    writeExecutable(Path.join(explicitDir, "codex"), "#!/bin/sh\n");
    const discovery = await Effect.runPromise(
      discoverServicePath({ env: serviceEnv(), home, shell: null, explicitDirs: [explicitDir] }),
    );
    expect(discovery.entries[0]).toEqual({ dir: explicitDir, source: "explicit" });
    expect(discovery.path.split(":")[0]).toBe(explicitDir);

    const configured = "/opt/custom/bin/codex";
    const resolved = await Effect.runPromise(
      resolveProviderExecutable({ configuredPath: configured, commandNames: ["codex"], discovery }),
    );
    expect(resolved).toEqual({ source: "explicit", path: configured });

    const bareName = await Effect.runPromise(
      resolveProviderExecutable({ commandNames: ["codex"], discovery }),
    );
    expect(bareName).toMatchObject({ path: Path.join(explicitDir, "codex") });
  });

  it("orders explicit, login shell, version managers, then inherited PATH", async () => {
    makeNvmLayout();
    const shell = fakeShell(
      "custom",
      'PATH=/opt/login/bin:/usr/bin; export PATH; exec /bin/sh -c "$2"',
    );
    const discovery = await Effect.runPromise(
      discoverServicePath({
        env: { HOME: home, PATH: "/inherited/bin:/usr/bin" },
        home,
        shell,
        platform: "linux",
        explicitDirs: ["/explicit/bin", "relative/ignored"],
      }),
    );
    const sources = discovery.entries.map((entry) => `${entry.source}:${entry.dir}`);
    expect(sources.slice(0, 3)).toEqual([
      "explicit:/explicit/bin",
      "loginShell:/opt/login/bin",
      "loginShell:/usr/bin",
    ]);
    expect(sources.at(-1)).toBe("inherited:/inherited/bin");
    expect(sources.filter((entry) => entry.startsWith("versionManager:")).length).toBe(2);
  });

  it("bounds a hanging profile with a timeout and kills its process group", async () => {
    makeNvmLayout();
    const pidFile = Path.join(root, "sleep.pid");
    const shell = fakeShell("hang", `sleep 30 & echo $! > '${pidFile}'; wait`);
    const started = Date.now();
    const discovery = await Effect.runPromise(
      discoverServicePath({ env: serviceEnv(), home, shell, timeoutMs: 300, platform: "linux" }),
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(discovery.shell.status).toBe("timeout");
    // Discovery still falls back to version-manager directories.
    expect(discovery.entries.some((entry) => entry.manager === "nvm")).toBe(true);
    const sleeper = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(sleeper, 0)).toThrow();
  });

  it("stops reading oversized profile output", async () => {
    const shell = fakeShell("noisy", "while :; do echo noisy-profile-output; done");
    const discovery = await Effect.runPromise(
      discoverServicePath({
        env: serviceEnv(),
        home,
        shell,
        maxOutputBytes: 4_096,
        timeoutMs: 5_000,
        platform: "linux",
      }),
    );
    expect(discovery.shell.status).toBe("oversize");
    expect(discovery.entries.map((entry) => entry.dir)).toEqual(["/usr/bin", "/bin"]);
  });

  it("reports a missing shell as failed without throwing", async () => {
    const discovery = await Effect.runPromise(
      discoverServicePath({ env: serviceEnv(), home, shell: Path.join(root, "nope") }),
    );
    expect(discovery.shell.status).toBe("failed");
  });
});
