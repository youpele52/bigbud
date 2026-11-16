import { lstat, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { runArchive } from "../../../../scripts/lib/remote-backend-control/archive.ts";
import { extractMobileOptionalAssets } from "./mobileOptionalAssets.ts";
import { extractMobileAssetGzip } from "./mobileOptionalAssets.gzip.ts";
import { MobileAssetTarParser } from "./mobileOptionalAssets.tar.ts";
import {
  MOBILE_ASSET_MAX_EXPANDED_BYTES,
  MOBILE_ASSET_MAX_ENTRIES,
} from "@bigbud/shared/mobileOptionalAssets.policy";
import {
  checksum,
  signedRequest,
  tarBytes,
  tarMember,
} from "./mobileOptionalAssets.test-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function parent(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bigbud-mobile-extract-bounds-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
function noFilesParser(): MobileAssetTarParser {
  return new MobileAssetTarParser({
    directory: async () => {},
    completedFile: () => {},
    file: async () => {
      throw new Error("Test must reject before file IO.");
    },
  });
}

it("reads actual deterministic Python producer archives with long PAX paths", async () => {
  const root = await parent();
  const path = "a".repeat(120) + ".js";
  const indexSource = join(root, "index.html");
  const jsSource = join(root, path);
  await writeFile(indexSource, "<html>producer fixture</html>");
  await writeFile(jsSource, "const actualProducer = true;");
  const entries = await Promise.all(
    [indexSource, jsSource].map(async (source) => {
      const bytes = await readFile(source);
      return {
        path: source.slice(root.length + 1),
        kind: "file" as const,
        mode: 0o644,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        source,
      };
    }),
  );
  const archive = join(root, "producer.tar.gz");
  // Existing BUILD-time fixture helper only. Runtime extractor imports no Python/tar tool.
  runArchive({ action: "create", entries, archive });
  const request = signedRequest(root, Buffer.alloc(0), await readFile(archive));
  const destination = await extractMobileOptionalAssets(request);
  expect(await readFile(join(destination!, path), "utf8")).toBe("const actualProducer = true;");
});

it("bounds the number of entries even for empty directories", async () => {
  const parser = noFilesParser();
  const members = Array.from({ length: MOBILE_ASSET_MAX_ENTRIES + 1 }, (_, index) =>
    tarMember(`d${index}`, "5", ""),
  );
  await expect(parser.consume(tarBytes(members))).rejects.toThrow(/[Ee]xcessive/);
});
it("bounds decompressed headers and zero padding independently of content bytes", async () => {
  const compressed = gzipSync(Buffer.alloc(MOBILE_ASSET_MAX_EXPANDED_BYTES + 512));
  await expect(extractMobileAssetGzip(compressed, noFilesParser())).rejects.toThrow(
    /expansion budget/,
  );
});
it("bounds declared content and local PAX allocation before payload IO", async () => {
  const content = tarMember("index.html", "0", "");
  content.write((128 * 1024 * 1024 + 1).toString(8).padStart(11, "0") + "\0", 124);
  checksum(content.subarray(0, 512));
  await expect(noFilesParser().consume(content)).rejects.toThrow(/content budget/);
  const pax = tarMember("././@PaxHeader", "x", "");
  pax.write((16 * 1024 + 1).toString(8).padStart(11, "0") + "\0", 124);
  checksum(pax.subarray(0, 512));
  await expect(noFilesParser().consume(pax)).rejects.toThrow(/PAX/);
});
it("bounds path depth", async () => {
  await expect(noFilesParser().consume(tarMember("a/".repeat(34) + "app.js"))).rejects.toThrow(
    /Unsafe/,
  );
});
it("accepts producer-compatible files beneath exactly 32 directory levels", async () => {
  const root = await parent();
  const members = [tarMember("index.html", "0", "fixture")];
  for (let depth = 1; depth <= 32; depth += 1) members.push(tarMember("a/".repeat(depth), "5", ""));
  const path = "a/".repeat(32) + "app.js";
  members.push(tarMember(path, "0", "depth boundary fixture"));
  const destination = await extractMobileOptionalAssets(signedRequest(root, tarBytes(members)));
  expect(await readFile(join(destination!, path), "utf8")).toBe("depth boundary fixture");
});
it("cancels active extraction, closes IO and preserves uncertain incomplete output", async () => {
  const root = await parent();
  const controller = new AbortController();
  const tar = tarBytes([tarMember("index.html", "0", "x".repeat(8 * 1024 * 1024))]);
  const request = { ...signedRequest(root, tar), signal: controller.signal };
  const outcome = extractMobileOptionalAssets(request).then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error }),
  );
  let observed = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(join(request.destination, "index.html"));
      observed = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  expect(observed).toBe(true);
  controller.abort(new Error("revoked during extraction"));
  expect((await outcome).error).not.toBeNull();
  const remaining = await readdir(root);
  if (remaining.length) {
    expect(remaining).toEqual(["fresh-assets"]);
    expect(await readdir(request.destination)).toEqual(["index.html"]);
    const path = join(request.destination, "index.html");
    expect((await lstat(path)).mode & 0o077).toBe(0);
    const settledBytes = await readFile(path);
    expect(settledBytes.length).toBeLessThanOrEqual(8 * 1024 * 1024);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await readFile(path)).toEqual(settledBytes);
  }
});
