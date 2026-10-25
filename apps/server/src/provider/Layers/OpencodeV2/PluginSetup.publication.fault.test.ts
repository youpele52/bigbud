import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { publishV2ManagedPlugin } from "./PluginSetup.publication.ts";
import { v2ManagedPluginFilename } from "./PluginSetup.record.ts";

const fault = vi.hoisted(() => ({ mode: "none" as "none" | "write" | "collision" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (fault.mode === "write" && String(args[0]).endsWith(".pending"))
        handle.writeFile = async () => {
          throw Object.assign(new Error("Disposable injected publication write failure"), {
            code: "ENOSPC",
          });
        };
      return handle;
    },
    link: async (...args: Parameters<typeof fs.link>) => {
      if (
        fault.mode === "collision" &&
        /bigbud-thread-tools-[a-f0-9]{64}\.js$/.test(String(args[1]))
      )
        await fs.writeFile(args[1], "// foreign publication won", { mode: 0o600, flag: "wx" });
      return fs.link(...args);
    },
  };
});

it.skipIf(process.platform === "win32")(
  "physical write failure is retryable only from signed reserved evidence; first-publication collision is never overwritten",
  async () => {
    for (const mode of ["write", "collision"] as const) {
      const app = await makeV2ThreadPluginFixture();
      try {
        const root = path.join(app.root, "native-config");
        await mkdir(root);
        const config = path.join(root, "opencode.jsonc");
        const original = '// unchanged user file\n{"plugins":[]}\n';
        await writeFile(config, original, { mode: 0o600 });
        const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
        const filename = path.join(root, "plugins", v2ManagedPluginFilename(app.artifact));
        fault.mode = mode;
        await expect(publishV2ManagedPlugin(app.artifact, root, authority)).rejects.toThrow();
        fault.mode = "none";
        expect(await readFile(config, "utf8")).toBe(original);
        if (mode === "write") {
          await expect(lstat(filename)).rejects.toThrow();
          await publishV2ManagedPlugin(app.artifact, root, authority);
          expect(await readFile(filename, "utf8")).toContain(app.artifact.entryUri);
        } else {
          expect(await readFile(filename, "utf8")).toBe("// foreign publication won");
          await expect(publishV2ManagedPlugin(app.artifact, root, authority)).rejects.toThrow(
            "collision preserved",
          );
        }
      } finally {
        fault.mode = "none";
        await app.close();
      }
    }
  },
);
