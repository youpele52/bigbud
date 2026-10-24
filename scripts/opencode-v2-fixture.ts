import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, appendFile, chmod } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Download a test-owned official binary only. No installation, scripts, native service or user HOME access.
// `--qualification` additionally exports the private-binary variable and writes `fixture.json`
// provenance next to the package for the native qualification job.
const args = process.argv.slice(2);
const qualification = args.includes("--qualification");
const [version, directory] = args.filter((arg) => arg !== "--qualification");
const VERSIONS = ["2.0.24", "2.0.26", "2.0.29", "2.1.4"];
// Registry metadata pinned at preparation time for the qualification target; any drift refuses.
const PINNED: Record<string, { integrity: string; tarball: string }> = {
  "2.1.4 darwin-arm64": {
    integrity:
      "sha512-QwjyvovTdT0gFi5rxUyPVlYePIe3ELduR9olu+KJWe089XVIDOTMhxylBe/ZGIpvoXHYo6bp2NskIiqCFAEXsw==",
    tarball: "https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.1.4.tgz",
  },
};
if (!version || !VERSIONS.includes(version) || !directory || !path.isAbsolute(directory))
  throw new Error(
    `Usage: opencode-v2-fixture.ts <${VERSIONS.join("|")}> <absolute disposable directory> [--qualification]`,
  );
const platform = process.platform === "win32" ? "windows" : process.platform;
if (!["windows", "linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(process.arch))
  throw new Error("Unsupported fixture target.");
const name = `@opencode/cli-${platform}-${process.arch}`;
const pinned = PINNED[`${version} ${platform}-${process.arch}`];
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
  new URL(metadata.dist.tarball).origin !== "https://registry.npmjs.org" ||
  (pinned &&
    (metadata.dist.integrity !== pinned.integrity || metadata.dist.tarball !== pinned.tarball))
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
// Native isolation requires a non-writable single-link image owned by the test user.
if (process.platform !== "win32") await chmod(binary, 0o555);
const sha256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const provenance = {
  name,
  version,
  url: metadata.dist.tarball,
  integrity: metadata.dist.integrity,
  binaryPath: binary,
  binarySha256: sha256,
};
console.log(JSON.stringify(provenance));
if (qualification)
  await writeFile(path.join(directory, "fixture.json"), `${JSON.stringify(provenance, null, 2)}\n`);
if (process.env.GITHUB_ENV)
  await appendFile(
    process.env.GITHUB_ENV,
    `BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY=${binary}\nBIGBUD_OPENCODE_V2_SHARED_TEST_VERSION=${version}\nBIGBUD_OPENCODE_V2_REQUIRED_NATIVE=1\n${
      qualification ? `BIGBUD_OPENCODE_V2_TEST_BINARY=${binary}\n` : ""
    }`,
  );
else console.log(binary);
