import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { readV2WindowsRegistration, v2WindowsInspector } from "./SharedService.windows.ts";
import { ownV2WindowsFixture } from "./SharedService.windows.fixture.mjs";

it.skipIf(process.platform !== "win32")(
  "reads only private same-handle bounded registration and rejects foreign read grants",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2 native inspection "));
    const file = path.join(root, "registration.json");
    try {
      await writeFile(file, '{"fixture":"only"}');
      await ownV2WindowsFixture(root);
      expect((await readV2WindowsRegistration(file)).toString()).toBe('{"fixture":"only"}');
      execFileSync("icacls.exe", [file, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
      await expect(readV2WindowsRegistration(file)).rejects.toThrow("rejected");
      execFileSync("icacls.exe", [file, "/remove:g", "*S-1-1-0"], { stdio: "ignore" });
      const alias = path.join(root, "junction");
      await symlink(root, alias, "junction");
      await expect(
        readV2WindowsRegistration(path.join(alias, "registration.json")),
      ).rejects.toThrow("rejected");
      await rm(alias);
      execFileSync("icacls.exe", [root, "/grant", "*S-1-1-0:(DC)"], { stdio: "ignore" });
      await expect(readV2WindowsRegistration(file)).rejects.toThrow("rejected");
      execFileSync("icacls.exe", [root, "/remove:g", "*S-1-1-0"], { stdio: "ignore" });
      await writeFile(file, "x".repeat(16_385));
      await expect(readV2WindowsRegistration(file)).rejects.toThrow("rejected");
      await expect(v2WindowsInspector.request("STOP\t1")).rejects.toThrow("rejected");
      await expect(v2WindowsInspector.request("PROCESS\t0")).rejects.toThrow("rejected");
    } finally {
      v2WindowsInspector.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
