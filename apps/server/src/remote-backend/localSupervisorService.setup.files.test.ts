import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { publishServiceFile } from "./localSupervisorService.setup.files.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/sf-"));
  roots.push(root);
  await fs.chmod(root, 0o700);
  return root;
}
it("publishes complete private single-link files without replacing an existing name", async () => {
  const root = await fixture(),
    path = join(root, "config");
  await publishServiceFile(path, "first", async () => {});
  expect(await fs.readFile(path, "utf8")).toBe("first");
  const stat = await fs.stat(path);
  expect(stat.mode & 0o777).toBe(0o600);
  expect(stat.nlink).toBe(1);
  await expect(publishServiceFile(path, "second", async () => {})).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await fs.readFile(path, "utf8")).toBe("first");
});
it("preserves an unpublished private temporary on lost ownership before atomic publication", async () => {
  const root = await fixture(),
    path = join(root, "config");
  let checks = 0;
  await expect(
    publishServiceFile(path, "fixture", async () => {
      if (++checks === 2) throw new Error("ownership lost");
    }),
  ).rejects.toThrow("ownership lost");
  await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  const names = await fs.readdir(root);
  expect(names).toHaveLength(1);
  const temporary = join(root, names[0]!);
  expect((await fs.stat(temporary)).mode & 0o777).toBe(0o600);
  expect(await fs.readFile(temporary, "utf8")).toBe("fixture");
});
it("refuses a parent replacement before linking into an unowned namespace", async () => {
  const base = await fixture(),
    root = join(base, "service");
  await fs.mkdir(root, { mode: 0o700 });
  let checks = 0;
  await expect(
    publishServiceFile(join(root, "config"), "fixture", async () => {
      if (++checks === 2) {
        await fs.rename(root, join(base, "prior"));
        await fs.mkdir(root, { mode: 0o700 });
      }
    }),
  ).rejects.toThrow("directory changed");
  expect(await fs.readdir(root)).toEqual([]);
  expect(await fs.readdir(join(base, "prior"))).toHaveLength(1);
});
