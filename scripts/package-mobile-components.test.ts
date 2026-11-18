import { gzipSync } from "node:zlib";
import { MOBILE_ASSET_MAX_EXPANDED_BYTES } from "@bigbud/shared/mobileOptionalAssets.policy";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, link, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import {
  verifyMobileOptionalArtifactBytes,
  verifyMobileOptionalArtifactSignature,
} from "@bigbud/shared/mobileOptionalArtifact";
import { runArchive } from "./lib/remote-backend-control/archive.ts";
import { assertGatewayHeader } from "./package-mobile-components.binary.ts";
import { cleanupMobileFixtures, elf, mobileFixture } from "./package-mobile-components.fixture.ts";
import { packageMobileComponents } from "./package-mobile-components.producer.ts";

afterEach(cleanupMobileFixtures);

it("produces deterministic separate artifacts with verified signatures and no private source inventory", async () => {
  const { root, input, key, privatePem } = await mobileFixture();
  const first = await packageMobileComponents(input);
  const second = await packageMobileComponents({ ...input, outputDirectory: join(root, "out2") });
  expect(second).toEqual(first);
  const manifest = await readFile(join(input.outputDirectory, "manifest.json"), "utf8");
  expect(manifest).not.toContain(privatePem);
  expect(manifest).not.toContain(root);
  const trusted = {
    "fixture-key": createPublicKey(key.privateKey)
      .export({ type: "spki", format: "pem" })
      .toString(),
  };
  for (const artifact of first) {
    verifyMobileOptionalArtifactSignature(artifact, trusted);
    const name = new URL(artifact.url).pathname.split("/").at(-1)!;
    const bytes = await readFile(join(input.outputDirectory, name));
    verifyMobileOptionalArtifactBytes(artifact, bytes);
    expect(bytes.equals(await readFile(join(root, "out2", name)))).toBe(true);
    expect(bytes.includes(Buffer.from(privatePem))).toBe(false);
  }
});

it.each([
  ".env",
  ".git",
  "credentials.json",
  "secret.json",
  "private-key.txt",
  "debug.map",
  "../escape",
])("rejects unsafe/private assets %s without a signed manifest", async (name) => {
  const { input } = await mobileFixture();
  if (name === "../escape") {
    await expect(
      packageMobileComponents({
        ...input,
        compatibility: { ...input.compatibility, gatewayVersion: name },
      }),
    ).rejects.toThrow();
    return;
  }
  await writeFile(join(input.assetsDirectory, name), "private fixture");
  await expect(packageMobileComponents(input)).rejects.toThrow(/private|[Uu]nsupported/);
  await expect(readFile(join(input.outputDirectory, "manifest.json"))).rejects.toThrow();
  expect(await readFile(join(input.outputDirectory, "UNPUBLISHED.txt"), "utf8")).toContain(
    "Do not publish",
  );
});

it.each(["symlink", "hardlink", "key-content"])("rejects %s assets", async (kind) => {
  const { input, privatePem } = await mobileFixture();
  const destination = join(input.assetsDirectory, "untrusted.txt");
  if (kind === "symlink") await symlink(input.keyFile, destination);
  else if (kind === "hardlink") await link(join(input.assetsDirectory, "index.html"), destination);
  else await writeFile(destination, privatePem);
  await expect(packageMobileComponents(input)).rejects.toThrow(/link|Credential/);
  await expect(readFile(join(input.outputDirectory, "manifest.json"))).rejects.toThrow();
});

it("refuses a signing key anywhere under the asset input", async () => {
  const { input, privatePem } = await mobileFixture();
  const keyFile = join(input.assetsDirectory, "signer.txt");
  await writeFile(keyFile, privatePem, { mode: 0o600 });
  await expect(packageMobileComponents({ ...input, keyFile })).rejects.toThrow(/separate/);
});
it.each(["permissions", "symlink", "wrong-algorithm"])(
  "refuses unsafe signing key %s",
  async (kind) => {
    const { input, root } = await mobileFixture();
    let keyFile = input.keyFile;
    if (kind === "permissions") await chmod(keyFile, 0o644);
    else if (kind === "symlink") {
      keyFile = join(root, "key-link");
      await symlink(input.keyFile, keyFile);
    } else {
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
      await writeFile(keyFile, rsa.privateKey.export({ type: "pkcs8", format: "pem" }));
    }
    await expect(packageMobileComponents({ ...input, keyFile })).rejects.toThrow(
      /owner-only|links|Ed25519/,
    );
  },
);

it("refuses nested output and never overwrites an existing directory", async () => {
  const { input } = await mobileFixture();
  await expect(
    packageMobileComponents({ ...input, outputDirectory: join(input.assetsDirectory, "out") }),
  ).rejects.toThrow(/separate/);
  await mkdir(input.outputDirectory);
  await writeFile(join(input.outputDirectory, "preserved"), "preserved");
  await expect(packageMobileComponents(input)).rejects.toThrow();
  expect(await readFile(join(input.outputDirectory, "preserved"), "utf8")).toBe("preserved");
});

it.each(["assets", "gateway", "key"])(
  "fails source %s mutation before manifest publication",
  async (source) => {
    const { input } = await mobileFixture();
    await expect(
      packageMobileComponents(input, {
        archive: (request) => {
          const result = runArchive(request);
          if (request.action === "create") {
            const path =
              source === "assets"
                ? join(input.assetsDirectory, "index.html")
                : source === "gateway"
                  ? input.gatewayBinary
                  : input.keyFile;
            writeFileSync(path, source === "gateway" ? Buffer.alloc(64) : "changed source");
          }
          return result;
        },
      }),
    ).rejects.toThrow();
    await expect(readFile(join(input.outputDirectory, "manifest.json"))).rejects.toThrow();
    expect(await readFile(join(input.outputDirectory, "UNPUBLISHED.txt"), "utf8")).toContain(
      "Do not publish",
    );
  },
);

it("rejects missing index, wrong architecture, credentialed URLs and inverted RPC ranges", async () => {
  const { input } = await mobileFixture();
  await expect(
    packageMobileComponents({ ...input, targetTriple: "x86_64-unknown-linux-musl" }),
  ).rejects.toThrow(/ELF/);
  await expect(
    packageMobileComponents({ ...input, artifactBaseUrl: "https://secret@github.com/releases/" }),
  ).rejects.toThrow(/credential/);
  await expect(
    packageMobileComponents({
      ...input,
      compatibility: { ...input.compatibility, minimumMobileRpcRevision: 3 },
    }),
  ).rejects.toThrow(/inverted/);
  await rm(join(input.assetsDirectory, "index.html"));
  await expect(packageMobileComponents(input)).rejects.toThrow(/index.html/);
});

it("recognizes narrow native executable headers without ever running them", () => {
  expect(() => assertGatewayHeader(elf(), "aarch64-unknown-linux-musl")).not.toThrow();
  expect(() => assertGatewayHeader(elf(), "x86_64-unknown-linux-musl")).toThrow();
  const mach = Buffer.alloc(32);
  mach.writeUInt32LE(0xfeedfacf);
  mach.writeUInt32LE(0x0100000c, 4);
  mach.writeUInt32LE(2, 12);
  expect(() => assertGatewayHeader(mach, "aarch64-apple-darwin")).not.toThrow();
  expect(() => assertGatewayHeader(mach, "x86_64-apple-darwin")).toThrow();
  const pe = Buffer.alloc(128);
  pe.write("MZ");
  pe.writeUInt32LE(64, 0x3c);
  pe.writeUInt32LE(0x00004550, 64);
  pe.writeUInt16LE(0x8664, 68);
  pe.writeUInt16LE(2, 86);
  pe.writeUInt16LE(0x20b, 88);
  expect(() => assertGatewayHeader(pe, "x86_64-pc-windows-msvc")).not.toThrow();
  expect(() => assertGatewayHeader(pe, "aarch64-pc-windows-msvc")).toThrow();
});

it("CLI fails closed without explicit required inputs and never prints a signing key", () => {
  const result = spawnSync("bun", ["run", "scripts/package-mobile-components.ts"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Missing required --gateway-binary");
  expect(result.stdout).not.toContain("PRIVATE KEY");
});

it("bounds assets, key size and directory nesting before producing any manifest", async () => {
  const { input, root } = await mobileFixture();
  await writeFile(join(input.assetsDirectory, "oversize.js"), "");
  await truncate(join(input.assetsDirectory, "oversize.js"), 128 * 1024 * 1024 + 1);
  await expect(packageMobileComponents(input)).rejects.toThrow(/byte budget/);
  await expect(readFile(join(input.outputDirectory, "manifest.json"))).rejects.toThrow();
  await writeFile(input.keyFile, Buffer.alloc(16 * 1024 + 1));
  await expect(
    packageMobileComponents({ ...input, outputDirectory: join(root, "out2") }),
  ).rejects.toThrow(/bounded/);
});

it("bounds asset directory nesting without following links", async () => {
  const { input } = await mobileFixture();
  let directory = input.assetsDirectory;
  for (let depth = 0; depth < 34; depth += 1) {
    directory = join(directory, "nested");
    await mkdir(directory);
  }
  await expect(packageMobileComponents(input)).rejects.toThrow(/depth budget|Unsafe/);
});

it("fails corrupted archive contents before exposing a manifest", async () => {
  const { input } = await mobileFixture();
  await expect(
    packageMobileComponents(input, {
      archive: (request) => {
        const result = runArchive(request);
        if (request.action === "create") writeFileSync(request.archive, "invalid gzip fixture");
        return result;
      },
    }),
  ).rejects.toThrow(/archive/);
  await expect(readFile(join(input.outputDirectory, "manifest.json"))).rejects.toThrow();
});

it("rejects total archive header/PAX/padding expansion before signing any metadata", async () => {
  const { input } = await mobileFixture();
  const bomb = gzipSync(Buffer.alloc(MOBILE_ASSET_MAX_EXPANDED_BYTES + 512));
  await expect(
    packageMobileComponents(input, {
      archive: (request) => {
        const result = runArchive(request);
        if (request.action === "create") writeFileSync(request.archive, bomb);
        return result;
      },
    }),
  ).rejects.toThrow(/total expansion budget/);
  await expect(readFile(join(input.outputDirectory, "manifest.json"))).rejects.toThrow();
  expect(await readFile(join(input.outputDirectory, "UNPUBLISHED.txt"), "utf8")).toContain(
    "Do not publish",
  );
});
