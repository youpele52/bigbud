import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MobileComponentBuildInput } from "./package-mobile-components.producer.ts";

/** Test-only fixtures for the mobile component producer. */
const roots: string[] = [];
export async function cleanupMobileFixtures() {
  for (const root of roots.splice(0)) {
    for (const output of ["out", "out2"]) await chmod(join(root, output), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
export function elf(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(183, 18);
  return bytes;
}
export async function mobileFixture() {
  const root = await mkdtemp(join(tmpdir(), "bigbud-mobile-producer-"));
  roots.push(root);
  const assets = join(root, "assets");
  await mkdir(assets);
  await mkdir(join(assets, "static"));
  await writeFile(join(assets, "index.html"), "<html>fixture static mobile entry</html>");
  await writeFile(join(assets, "static", "app.js"), "console.log('static fixture');");
  const key = generateKeyPairSync("ed25519");
  const privatePem = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const keyFile = join(root, "signing.pem");
  await writeFile(keyFile, privatePem, { mode: 0o600 });
  const gateway = join(root, "gateway");
  await writeFile(gateway, elf());
  const input: MobileComponentBuildInput = {
    gatewayBinary: gateway,
    targetTriple: "aarch64-unknown-linux-musl",
    assetsDirectory: assets,
    compatibility: {
      agentVersion: "1",
      backendVersion: "2",
      gatewayVersion: "3",
      mobileAssetVersion: "4",
      minimumMobileRpcRevision: 1,
      maximumMobileRpcRevision: 2,
    },
    artifactBaseUrl: "https://github.com/example/releases/download/test/",
    keyId: "fixture-key",
    keyFile,
    outputDirectory: join(root, "out"),
  };
  return { root, input, key, privatePem };
}
