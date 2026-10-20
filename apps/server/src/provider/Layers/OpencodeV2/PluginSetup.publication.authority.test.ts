import { mkdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { publishV2ManagedPlugin } from "./PluginSetup.publication.ts";
import { v2ManagedPluginFilename } from "./PluginSetup.record.ts";

const state = vi.hoisted(() => ({ changed: false, link: 0, rename: 0 }));
vi.mock("./Orchestration.plugin.ts", async (original) => {
  const source = await original<typeof import("./Orchestration.plugin.ts")>();
  return {
    ...source,
    renderV2ThreadPlugin: () =>
      source.renderV2ThreadPlugin() + (state.changed ? "\n// Owned S1 revision\n" : ""),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    link: (...args: Parameters<typeof fs.link>) => {
      if (/bigbud-thread-tools-[a-f0-9]{64}\.js$/.test(String(args[1]))) state.link++;
      return fs.link(...args);
    },
    rename: (...args: Parameters<typeof fs.rename>) => {
      if (/bigbud-thread-tools-[a-f0-9]{64}\.js$/.test(String(args[1]))) state.rename++;
      return fs.rename(...args);
    },
  };
});

it.each(["first", "replacement"] as const)(
  "%s publication cannot issue a filesystem mutation after a completed hook queues authority loss",
  async (kind) => {
    for (const loss of ["scope", "abort", "gate"] as const) {
      const app = await makeV2ThreadPluginFixture(),
        root = path.join(app.root, "owned-config"),
        controller = new AbortController();
      await mkdir(root, { mode: 0o700 });
      const filename = path.join(root, "plugins", v2ManagedPluginFilename(app.artifact));
      let current = true,
        liveGate = true;
      const authority = {
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) throw new Error("V2 changed scope");
        },
      };
      try {
        if (kind === "replacement") await publishV2ManagedPlugin(app.artifact, root, authority);
        const before =
          kind === "replacement"
            ? { bytes: await readFile(filename), stat: await lstat(filename) }
            : undefined;
        state.changed = kind === "replacement";
        const next = state.changed ? await exportV2ThreadArtifact(app.root) : app.artifact;
        state.link = 0;
        state.rename = 0;
        await expect(
          publishV2ManagedPlugin(next, root, {
            ...authority,
            publication: {
              joinPhysicalOnCancel: true,
              prepare: async () => {},
              locked: async () => () => {},
              assertGate: () => {
                if (!liveGate) throw new Error("V2 gate deadline expired");
              },
              beforeMutation: async () => {
                queueMicrotask(() => {
                  if (loss === "scope") current = false;
                  else if (loss === "abort") controller.abort();
                  else liveGate = false;
                });
              },
            },
          }),
        ).rejects.toThrow();
        expect(state.link + state.rename).toBe(0);
        if (before) {
          expect(await readFile(filename)).toEqual(before.bytes);
          expect((await lstat(filename)).ino).toBe(before.stat.ino);
          expect((await lstat(filename)).mtimeMs).toBe(before.stat.mtimeMs);
        } else await expect(lstat(filename)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        state.changed = false;
        await app.close();
      }
    }
  },
);
