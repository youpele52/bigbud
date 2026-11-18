import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPinnedReleaseSigningKey } from "@bigbud/shared/releaseTrust";

/**
 * Release guard for signers that do not go through verify-remote-agent-release-assets (the backend
 * graph workflow): refuse to sign with a key that shipped clients do not pin.
 */
export function verifyReleaseSigningKeyPin(input: {
  readonly signingKeyPem: string;
  readonly signingKeyId: string;
  readonly pinnedTrustStore?: Readonly<Record<string, string>>;
}): void {
  const publicKeyPem = createPublicKey(input.signingKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  assertPinnedReleaseSigningKey(
    { keyId: input.signingKeyId, publicKeyPem },
    ...(input.pinnedTrustStore ? [input.pinnedTrustStore] : []),
  );
}

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    verifyReleaseSigningKeyPin({
      signingKeyPem: readFileSync(resolve(argumentValue("--key-file")), "utf8"),
      signingKeyId: argumentValue("--key-id"),
    });
    console.log("Release signing key is pinned by shipped clients.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
