import { chmod, mkdir, writeFile, symlink, link, lstat } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import {
  v2NativePluginDirectory,
  readV2NativePluginFile,
  ensureV2NativePluginsDirectory,
  removeV2NativePluginStaging,
} from "./PluginSetup.fs.ts";
import { resolveV2PluginConfigRoot } from "./PluginSetup.paths.ts";

it.skipIf(process.platform === "win32")(
  "resolves user-level config placement without any workspace input or hidden fallback",
  () => {
    expect(resolveV2PluginConfigRoot(undefined, { HOME: "/user", XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/opencode",
    );
    expect(resolveV2PluginConfigRoot(undefined, { HOME: "/user" })).toBe("/user/.config/opencode");
    expect(resolveV2PluginConfigRoot(undefined, { OPENCODE_CONFIG_DIR: "/native" })).toBe(
      "/native",
    );
    expect(resolveV2PluginConfigRoot(" /override/ ", { OPENCODE_CONFIG_DIR: "/native" })).toBe(
      "/override",
    );
    for (const root of ["relative", "/", "/native\0bad"])
      expect(() => resolveV2PluginConfigRoot(root)).toThrow("V2 automatic");
  },
);

it.skipIf(process.platform === "win32")(
  "allows existing owner 0755 config roots, refuses links/writable roots and preserves ordinary config bytes",
  async () => {
    const app = await makeV2ThreadPluginFixture();
    try {
      const root = path.join(app.root, "native-config");
      await mkdir(root, { mode: 0o755 });
      await chmod(root, 0o755);
      const identity = await v2NativePluginDirectory(root);
      const filename = path.join(root, "opencode.jsonc");
      const content = '// preserved comments\n{"plugins":[],"unrelated":"value"}\n';
      await writeFile(filename, content, { mode: 0o644 });
      expect((await readV2NativePluginFile(filename, false))?.content).toBe(content);
      await expect(readV2NativePluginFile(filename, true)).rejects.toThrow("owner file");
      const alias = path.join(root, "alias");
      await symlink(filename, alias);
      await expect(readV2NativePluginFile(alias, false)).rejects.toThrow();
      const hard = path.join(root, "hard");
      await link(filename, hard);
      await expect(readV2NativePluginFile(filename, false)).rejects.toThrow("singly linked");
      const controller = new AbortController();
      const authority = {
        signal: controller.signal,
        assertCurrent: () => controller.signal.throwIfAborted(),
      };
      const plugins = await ensureV2NativePluginsDirectory(root, identity, authority);
      expect((await lstat(plugins.directory)).mode & 0o077).toBe(0);
      await chmod(root, 0o777);
      await expect(v2NativePluginDirectory(root)).rejects.toThrow("unsafe");
      await chmod(root, 0o755);
      controller.abort();
      await expect(ensureV2NativePluginsDirectory(root, identity, authority)).rejects.toThrow();
    } finally {
      await app.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "conditional staging cleanup refuses a successor inode",
  async () => {
    const app = await makeV2ThreadPluginFixture();
    try {
      const directory = path.join(app.root, "plugins");
      await mkdir(directory);
      const filename = path.join(directory, ".staging.pending");
      await writeFile(filename, "owned", { mode: 0o600 });
      const info = await lstat(filename);
      await expect(
        removeV2NativePluginStaging(filename, { dev: info.dev, ino: info.ino + 1 }, () => {}),
      ).rejects.toThrow("successor");
      await removeV2NativePluginStaging(filename, info, () => {});
      expect(await readV2NativePluginFile(filename, true)).toBeUndefined();
    } finally {
      await app.close();
    }
  },
);
