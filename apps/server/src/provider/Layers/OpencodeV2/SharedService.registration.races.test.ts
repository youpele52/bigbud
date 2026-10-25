import { chmod, rename, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { sharedServiceTestRegistration } from "./SharedService.test.fixture.ts";
import { discoverV2SharedService } from "./SharedService.discovery.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof fs>()),
  open: vi.fn((...args: Parameters<typeof fs.open>) => actual.open(...args)),
}));
const actual = await vi.importActual<typeof fs>("node:fs/promises");
afterEach(() => vi.mocked(fs.open).mockReset().mockImplementation(actual.open));

it.skipIf(process.platform === "win32").each(["chmod", "rename", "symlink", "growth"])(
  "rejects %s during registration read before issuing any HTTP request",
  async (change) => {
    const fixture = await sharedServiceTestRegistration();
    const request = vi.fn();
    let changed = false;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs: unknown[]) => {
        const result = await Reflect.apply(read, handle, readArgs);
        if (!changed) {
          changed = true;
          if (change === "chmod") await chmod(fixture.file, 0o644);
          if (change === "growth") await writeFile(fixture.file, "x".repeat(16_385));
          if (change === "rename" || change === "symlink") {
            await rename(fixture.file, `${fixture.file}.old`);
            if (change === "rename")
              await writeFile(fixture.file, JSON.stringify(fixture.value), { mode: 0o600 });
            else await symlink(`${fixture.file}.old`, fixture.file);
          }
        }
        return result;
      });
      return handle;
    });
    try {
      await expect(
        discoverV2SharedService({ file: fixture.file, fetch: request as unknown as typeof fetch }),
      ).rejects.toThrow("registration is invalid");
      expect(changed).toBe(true);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  },
);
