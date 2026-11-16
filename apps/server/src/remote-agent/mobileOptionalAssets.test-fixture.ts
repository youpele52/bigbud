import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { MobileOptionalArtifact } from "@bigbud/contracts/server/mobileOptionalArtifact";
import { canonicalizeMobileOptionalArtifact } from "@bigbud/shared/mobileOptionalArtifact";
import type { MobileOptionalAssetsExtraction } from "./mobileOptionalAssets.ts";

export function checksum(header: Buffer): void {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
}
export function tarMember(name: string, type = "0", body: Buffer | string = "fixture"): Buffer {
  const content = Buffer.from(body);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  for (const [offset, size, value] of [
    [100, 8, type === "5" ? 0o755 : type === "x" ? 0 : 0o644],
    [108, 8, 0],
    [116, 8, 0],
    [124, 12, content.length],
    [136, 12, 0],
  ]) {
    header.write(value!.toString(8).padStart(size! - 1, "0") + "\0", offset!, "ascii");
  }
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  checksum(header);
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}
export function tarBytes(members: readonly Buffer[], termination = 1024): Buffer {
  return Buffer.concat([...members, Buffer.alloc(termination)]);
}
export function paxRecord(path: string, key = "path"): string {
  const body = `${key}=${path}\n`;
  let length = body.length + 2;
  while (`${length} ${body}`.length !== length) length = `${length} ${body}`.length;
  return `${length} ${body}`;
}

const keys = generateKeyPairSync("ed25519");
export function signedRequest(
  parent: string,
  tar: Buffer,
  compressed = gzipSync(tar),
): MobileOptionalAssetsExtraction {
  const artifact: MobileOptionalArtifact = {
    schemaVersion: 1,
    kind: "mobile-assets",
    format: "tar.gz",
    targetTriple: "portable",
    compatibility: {
      agentVersion: "1",
      backendVersion: "2",
      gatewayVersion: "3",
      mobileAssetVersion: "4",
      minimumMobileRpcRevision: 1,
      maximumMobileRpcRevision: 1,
    },
    sizeBytes: compressed.length,
    sha256: createHash("sha256").update(compressed).digest("hex"),
    url: "https://github.com/example/releases/download/test/assets.tar.gz",
    signature: { algorithm: "ed25519", keyId: "fixture", value: "" },
  };
  return {
    mobileConsent: true,
    artifact: {
      ...artifact,
      signature: {
        ...artifact.signature,
        value: sign(
          null,
          Buffer.from(canonicalizeMobileOptionalArtifact(artifact)),
          keys.privateKey,
        ).toString("base64"),
      },
    },
    bytes: compressed,
    trustedKeys: { fixture: keys.publicKey.export({ type: "spki", format: "pem" }).toString() },
    host: {
      targetTriple: "aarch64-unknown-linux-musl",
      agentVersion: "1",
      backendVersion: "2",
      mobileRpcRevision: 1,
    },
    release: { gatewayVersion: "3", mobileAssetVersion: "4" },
    destination: `${parent}/fresh-assets`,
  };
}
