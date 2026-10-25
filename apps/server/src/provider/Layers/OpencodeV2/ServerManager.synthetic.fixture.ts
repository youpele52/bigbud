import { readFile, writeFile, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { grantV2SyntheticNodeFixture } from "./ServerManager.synthetic.authorization.ts";

/** Explicit owned synthetic factory, not permission to run a configured retail/native image. */
export async function makeV2SyntheticExecutableFixture(root: string) {
  const canonical = await realpath(root),
    info = await lstat(canonical);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("V2 synthetic fixture root is not private/owned.");
  const binaryPath = path.join(canonical, "fixture-v2"),
    profileRoot = path.join(canonical, "profile");
  await writeFile(
    binaryPath,
    await readFile(new URL("./ServerManager.fixture.mjs", import.meta.url)),
    { mode: 0o400, flag: "wx" },
  );
  return {
    config: { binaryPath, profileRoot, runtimeTargetId: "local" },
    grant: await grantV2SyntheticNodeFixture(binaryPath, profileRoot),
  };
}
