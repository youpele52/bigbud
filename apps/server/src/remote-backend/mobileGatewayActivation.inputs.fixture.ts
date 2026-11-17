import { createHash, generateKeyPairSync, sign } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { MobileOptionalArtifact } from "@bigbud/contracts/server/mobileOptionalArtifact";
import { canonicalizeMobileOptionalArtifact } from "@bigbud/shared/mobileOptionalArtifact";
import { MOBILE_NATIVE_INPUTS_FILE } from "./mobileGatewayActivation.inputs.decode.ts";

export const inputsAuthorityId = "d".repeat(32);

/** Test-only signed descriptor over `bytes` with the fixture release key. */
export function signedMobileArtifact(
  kind: "mobile-gateway" | "mobile-assets",
  bytes: Buffer,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): MobileOptionalArtifact {
  const metadata: MobileOptionalArtifact = {
    schemaVersion: 1,
    ...(kind === "mobile-gateway"
      ? { kind, targetTriple: "x86_64-unknown-linux-musl" as const, format: "executable" as const }
      : { kind, targetTriple: "portable" as const, format: "tar.gz" as const }),
    compatibility: {
      agentVersion: "0.2.207",
      backendVersion: "0.0.0",
      gatewayVersion: "1",
      mobileAssetVersion: "1",
      minimumMobileRpcRevision: 1,
      maximumMobileRpcRevision: 1,
    },
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: `https://github.com/example/releases/download/fixture/${kind}`,
    signature: { algorithm: "ed25519", keyId: "fixture", value: "" },
  };
  const value = sign(null, Buffer.from(canonicalizeMobileOptionalArtifact(metadata)), privateKey);
  return { ...metadata, signature: { ...metadata.signature, value: value.toString("base64") } };
}

/** Real private home: 0700 service directory, 0600 artifacts and (optionally) the inputs file. */
export async function mobileInputsFixture() {
  const home = await fs.realpath(await fs.mkdtemp("/tmp/bb-minputs-"));
  const root = join(home, ".bigbud/backend-services", inputsAuthorityId);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const keys = generateKeyPairSync("ed25519");
  const gatewayBytes = Buffer.from("fixture gateway executable bytes");
  const assetsBytes = Buffer.from("fixture assets archive bytes");
  const gatewayPath = join(home, "gateway.bin");
  const assetsPath = join(home, "assets.tar.gz");
  await fs.writeFile(gatewayPath, gatewayBytes, { mode: 0o600 });
  await fs.writeFile(assetsPath, assetsBytes, { mode: 0o600 });
  const trustedKeys = {
    fixture: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const gateway = signedMobileArtifact("mobile-gateway", gatewayBytes, keys.privateKey);
  const assets = signedMobileArtifact("mobile-assets", assetsBytes, keys.privateKey);
  const file = {
    schemaVersion: 1,
    trustedKeys,
    stageId: "fixture-stage",
    gateway,
    assets,
    gatewayPath,
    assetsPath,
  };
  const path = join(root, MOBILE_NATIVE_INPUTS_FILE);
  return {
    home,
    root,
    path,
    keys,
    file,
    gatewayPath,
    assetsPath,
    write: async (content: unknown = file, mode = 0o600) => {
      await fs.rm(path, { force: true });
      await fs.writeFile(path, typeof content === "string" ? content : JSON.stringify(content), {
        mode,
      });
      await fs.chmod(path, mode);
    },
    close: () => fs.rm(home, { recursive: true, force: true }),
  };
}
