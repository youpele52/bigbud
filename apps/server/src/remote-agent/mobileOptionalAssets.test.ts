import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { extractMobileOptionalAssets } from "./mobileOptionalAssets.ts";
import {
  checksum,
  paxRecord,
  signedRequest,
  tarBytes,
  tarMember,
} from "./mobileOptionalAssets.test-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function parent(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bigbud-mobile-extract-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
const index = () => tarMember("index.html", "0", "<html>static fixture</html>");
async function refuses(tar: Buffer, pattern?: RegExp, preservedIncomplete?: string): Promise<void> {
  const root = await parent();
  const request = signedRequest(root, tar);
  const result = expect(extractMobileOptionalAssets(request)).rejects;
  if (pattern) await result.toThrow(pattern);
  else await result.toThrow();
  if (preservedIncomplete) {
    expect(await readdir(root)).toEqual(["fresh-assets"]);
    expect((await lstat(join(request.destination, preservedIncomplete))).mode & 0o077).toBe(0);
  } else expect(await readdir(root)).toEqual([]);
}

it("extracts a signed compatible static archive into fresh private staging", async () => {
  const root = await parent();
  const request = signedRequest(
    root,
    tarBytes([
      index(),
      tarMember("static/", "5", ""),
      tarMember("static/app.js", "0", "const fixture = true;"),
    ]),
  );
  const destination = await extractMobileOptionalAssets(request);
  expect(destination).not.toBeNull();
  expect(await readFile(join(destination!, "static/app.js"), "utf8")).toBe("const fixture = true;");
  expect((await lstat(destination!)).mode & 0o077).toBe(0);
  expect((await lstat(join(destination!, "index.html"))).mode & 0o077).toBe(0);
});
it("supports bounded producer-style local PAX path headers", async () => {
  const root = await parent();
  const path = "a".repeat(120) + ".js";
  const request = signedRequest(
    root,
    tarBytes([
      index(),
      tarMember("././@PaxHeader", "x", paxRecord(path)),
      tarMember(path.slice(0, 100), "0", "long-path fixture"),
    ]),
  );
  const destination = await extractMobileOptionalAssets(request);
  expect(await readFile(join(destination!, path), "utf8")).toBe("long-path fixture");
});

it("performs no IO or artifact inspection without separate consent", async () => {
  const root = await parent();
  const request = signedRequest(root, tarBytes([index()]));
  const denied = {
    ...request,
    mobileConsent: false,
    get artifact(): never {
      throw new Error("must not inspect");
    },
    get bytes(): never {
      throw new Error("must not inspect");
    },
  };
  expect(await extractMobileOptionalAssets(denied)).toBeNull();
  expect(await readdir(root)).toEqual([]);
});
it("verifies pinned signature, host compatibility and actual bytes before writes", async () => {
  const root = await parent();
  const request = signedRequest(root, tarBytes([index()]));
  await expect(extractMobileOptionalAssets({ ...request, trustedKeys: {} })).rejects.toThrow(
    /signature/,
  );
  await expect(
    extractMobileOptionalAssets({ ...request, host: { ...request.host, backendVersion: "other" } }),
  ).rejects.toThrow(/incompatible/);
  const corrupted = Buffer.from(request.bytes);
  corrupted[12] = corrupted[12]! ^ 1;
  await expect(extractMobileOptionalAssets({ ...request, bytes: corrupted })).rejects.toThrow(
    /SHA-256/,
  );
  await expect(
    extractMobileOptionalAssets({ ...request, bytes: new Uint8Array(0) }),
  ).rejects.toThrow(/size/);
  expect(await readdir(root)).toEqual([]);
});
it("snapshots mutable prepared bytes before any asynchronous IO", async () => {
  const root = await parent();
  const request = signedRequest(root, tarBytes([index()]));
  const work = extractMobileOptionalAssets(request);
  request.bytes.fill(0);
  expect(await work).not.toBeNull();
});
it("refuses an unprivate parent and preserves existing destinations", async () => {
  const root = await parent();
  const request = signedRequest(root, tarBytes([index()]));
  await chmod(root, 0o755);
  await expect(extractMobileOptionalAssets(request)).rejects.toThrow(/private/);
  await chmod(root, 0o700);
  await writeFile(request.destination, "preserved fixture");
  await expect(extractMobileOptionalAssets(request)).rejects.toThrow();
  expect(await readFile(request.destination, "utf8")).toBe("preserved fixture");
});
it("honors cancellation before extraction without creating staging", async () => {
  const root = await parent();
  const request = signedRequest(root, tarBytes([index()]));
  await expect(
    extractMobileOptionalAssets({ ...request, signal: AbortSignal.abort(new Error("cancelled")) }),
  ).rejects.toThrow("cancelled");
  expect(await readdir(root)).toEqual([]);
});

it.each([
  "../escape.js",
  "/escape.js",
  ".env",
  "dir/../escape.js",
  "dir\\escape.js",
  "credential.json",
  "secrets.json",
  "private-key.txt",
  "debug.map",
  "hidden/.git/file.js",
])("rejects unsafe/private path %s", async (path) => refuses(tarBytes([index(), tarMember(path)])));
it.each(["1", "2", "3", "4", "6", "7", "g"])("rejects link/special/global type %s", async (type) =>
  refuses(tarBytes([index(), tarMember("bad.js", type)]), /Links|special/),
);
it("rejects duplicate paths and case collisions", async () => {
  await refuses(tarBytes([index(), index()]), /Duplicate/);
  await refuses(tarBytes([index(), tarMember("INDEX.HTML")]), /case-colliding/);
});
it("requires explicit directory ancestors and forbids file ancestors", async () => {
  await refuses(tarBytes([index(), tarMember("missing/app.js")]), /ancestor/);
  await refuses(tarBytes([index(), tarMember("file.js"), tarMember("file.js/app.js")]), /ancestor/);
});
it("rejects corrupt checksums, numeric fields and nonzero payload padding", async () => {
  const badChecksum = index();
  badChecksum[0] = badChecksum[0]! ^ 1;
  await refuses(tarBytes([badChecksum]), /header/);
  const badSize = index();
  badSize.fill(255, 124, 136);
  checksum(badSize.subarray(0, 512));
  await refuses(tarBytes([badSize]));
  const padding = tarMember("index.html", "0", "short");
  padding[517] = 1;
  await refuses(tarBytes([padding]), /padding/);
});
it("rejects missing termination, trailing members, incomplete payload and missing index", async () => {
  await refuses(tarBytes([index()], 512), /Incomplete/);
  await refuses(Buffer.concat([tarBytes([index()]), tarMember("trailing.js")]), /Trailing/);
  await refuses(index().subarray(0, 515), /Incomplete/, "index.html");
  await refuses(tarBytes([tarMember("app.js")]), /index.html/);
});
it("rejects unsupported, duplicate and dangling local PAX records", async () => {
  await refuses(
    tarBytes([
      index(),
      tarMember("././@PaxHeader", "x", paxRecord("9", "size")),
      tarMember("app.js"),
    ]),
    /PAX/,
  );
  await refuses(
    tarBytes([index(), tarMember("././@PaxHeader", "x", paxRecord("app.js"))]),
    /Dangling/,
  );
  await refuses(
    tarBytes([
      index(),
      tarMember("././@PaxHeader", "x", paxRecord("app.js")),
      tarMember("././@PaxHeader", "x", paxRecord("other.js")),
    ]),
    /PAX/,
  );
  await refuses(
    tarBytes([
      index(),
      tarMember("././@PaxHeader", "x", paxRecord("../escape.js")),
      tarMember("app.js"),
    ]),
    /Unsafe/,
  );
});
it("rejects private key material even across inflater chunk boundaries", async () => {
  const content = "x".repeat(64 * 1024 - 520) + "-----BEGIN PRIVATE KEY-----";
  await refuses(tarBytes([index(), tarMember("app.js", "0", content)]), /Private key/, "app.js");
});
it("checks gzip CRC/size and rejects concatenated gzip members", async () => {
  const root = await parent();
  const tar = tarBytes([index()]);
  const compressed = gzipSync(tar);
  compressed[compressed.length - 8] = compressed[compressed.length - 8]! ^ 1;
  await expect(extractMobileOptionalAssets(signedRequest(root, tar, compressed))).rejects.toThrow(
    /corrupt/,
  );
  const concatenated = Buffer.concat([gzipSync(tar), gzipSync(Buffer.alloc(0))]);
  await expect(extractMobileOptionalAssets(signedRequest(root, tar, concatenated))).rejects.toThrow(
    /Concatenated/,
  );
  expect(await readdir(root)).toEqual([]);
});
