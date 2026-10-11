import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Download a test-owned official binary only. No installation, scripts, native service or user HOME access.
const [version, directory] = process.argv.slice(2);
if (
  !version ||
  !["2.0.24", "2.0.26"].includes(version) ||
  !directory ||
  !path.isAbsolute(directory)
)
  throw new Error("Usage: opencode-v2-fixture.ts <2.0.24|2.0.26> <absolute disposable directory>");
const platform = process.platform === "win32" ? "windows" : process.platform;
if (!["windows", "linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(process.arch))
  throw new Error("Unsupported fixture target.");
const name = `@opencode/cli-${platform}-${process.arch}`;
const response = await fetch(`https://registry.npmjs.org/${name}/${version}`, {
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error("Official fixture metadata unavailable.");
const metadata = (await response.json()) as {
  name: string;
  version: string;
  dist: { integrity: string; tarball: string };
};
if (
  metadata.name !== name ||
  metadata.version !== version ||
  !metadata.dist.integrity.startsWith("sha512-") ||
  new URL(metadata.dist.tarball).origin !== "https://registry.npmjs.org"
)
  throw new Error("Invalid fixture provenance.");
const download = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(120_000) });
if (!download.ok) throw new Error("Fixture download failed.");
const bytes = Buffer.from(await download.arrayBuffer());
if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== metadata.dist.integrity)
  throw new Error("Official registry integrity mismatch.");
await mkdir(directory, { recursive: true });
const archive = path.join(directory, "fixture.tgz");
await writeFile(archive, bytes);
const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 })
  .trim()
  .split(/\r?\n/);
if (
  files.some(
    (file) => !file.startsWith("package/") || file.split("/").includes("..") || file.includes("\\"),
  )
)
  throw new Error("Invalid fixture archive path.");
execFileSync("tar", ["-xzf", archive, "-C", directory]);
const binary = path.join(
  directory,
  "package",
  "bin",
  process.platform === "win32" ? "opencode.exe" : "opencode",
);
const sha256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
console.log(
  JSON.stringify({
    name,
    version,
    url: metadata.dist.tarball,
    integrity: metadata.dist.integrity,
    binarySha256: sha256,
  }),
);
if (process.env.GITHUB_ENV)
  await appendFile(
    process.env.GITHUB_ENV,
    `BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY=${binary}\nBIGBUD_OPENCODE_V2_SHARED_TEST_VERSION=${version}\nBIGBUD_OPENCODE_V2_REQUIRED_NATIVE=1\n`,
  );
else console.log(binary);
