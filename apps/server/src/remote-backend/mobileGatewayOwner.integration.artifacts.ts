/** Explicit disposable integration signer; never release trust or production artifact discovery. */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import * as fs from "node:fs/promises";
import { gzipSync } from "node:zlib";
import * as Schema from "effect/Schema";
import {
  MobileGatewayTarget,
  type MobileOptionalArtifact,
} from "@bigbud/contracts/server/mobileOptionalArtifact";
import { canonicalizeMobileOptionalArtifact } from "@bigbud/shared/mobileOptionalArtifact";
import { tarBytes, tarMember } from "../remote-agent/mobileOptionalAssets.test-fixture.ts";
import { version } from "../../package.json" with { type: "json" };

export async function ownerIntegrationArtifacts() {
  const binary = process.env.BIGBUD_OWNER_TEST_GATEWAY_BINARY;
  const expectedSha = process.env.BIGBUD_OWNER_TEST_GATEWAY_SHA256;
  const target = Schema.decodeUnknownSync(MobileGatewayTarget)(
    process.env.BIGBUD_OWNER_TEST_GATEWAY_TARGET,
  );
  if (
    process.platform !== "linux" ||
    !binary ||
    !/^[a-f0-9]{64}$/.test(expectedSha ?? "") ||
    !target.startsWith(
      process.arch === "arm64" ? "aarch64-unknown-linux-" : "x86_64-unknown-linux-",
    )
  )
    throw new Error("Explicit reviewed Linux gateway binary, digest and target are required.");
  const gatewayBytes = await fs.readFile(binary);
  if (
    gatewayBytes.subarray(0, 6).toString("hex") !== "7f454c460201" ||
    gatewayBytes.readUInt16LE(18) !== (process.arch === "arm64" ? 183 : 62) ||
    createHash("sha256").update(gatewayBytes).digest("hex") !== expectedSha
  )
    throw new Error("Reviewed gateway binary header/digest does not match this Linux fixture.");
  const assetsBytes = gzipSync(
    tarBytes([tarMember("index.html", "0", "<html>disposable owner integration fixture</html>")]),
  );
  const signer = generateKeyPairSync("ed25519");
  const artifact = (
    kind: "mobile-gateway" | "mobile-assets",
    bytes: Buffer,
  ): MobileOptionalArtifact => {
    const metadata: MobileOptionalArtifact = {
      schemaVersion: 1,
      ...(kind === "mobile-gateway"
        ? { kind, format: "executable", targetTriple: target }
        : { kind, format: "tar.gz", targetTriple: "portable" }),
      compatibility: {
        agentVersion: "0.2.207",
        backendVersion: version,
        gatewayVersion: "1",
        mobileAssetVersion: "1",
        minimumMobileRpcRevision: 1,
        maximumMobileRpcRevision: 1,
      },
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      url: `https://github.com/example/releases/download/fixture/${kind}`,
      signature: { algorithm: "ed25519", keyId: "owner-fixture", value: "" },
    };
    return {
      ...metadata,
      signature: {
        ...metadata.signature,
        value: sign(
          null,
          Buffer.from(canonicalizeMobileOptionalArtifact(metadata)),
          signer.privateKey,
        ).toString("base64"),
      },
    };
  };
  return {
    target,
    keys: { "owner-fixture": signer.publicKey.export({ type: "spki", format: "pem" }).toString() },
    request: {
      stageId: "owner-integration-one",
      consentRevision: 1,
      gateway: artifact("mobile-gateway", gatewayBytes),
      assets: artifact("mobile-assets", assetsBytes),
      gatewayBytes,
      assetsBytes,
    },
  };
}
