import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { readV2ThreadPrivateFile, writeV2ThreadPrivateFile } from "./Orchestration.storage.ts";

/** A separate private X25519 key never leaves the same validated issuer namespace. Key loss changes the immutable artifact. */
export async function openV2ThreadEncryptionKey(directory: string) {
  const filename = path.join(directory, "encryption.pem");
  let encryptionPrivateKey: string;
  try {
    encryptionPrivateKey = await readV2ThreadPrivateFile(filename);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const generated = generateKeyPairSync("x25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    try {
      await writeV2ThreadPrivateFile(filename, generated);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    encryptionPrivateKey = await readV2ThreadPrivateFile(filename);
  }
  const key = createPrivateKey(encryptionPrivateKey);
  if (key.asymmetricKeyType !== "x25519")
    throw new Error("V2 callback encryption key algorithm rejected.");
  return {
    encryptionPrivateKey,
    encryptionPublicKey: createPublicKey(key).export({ type: "spki", format: "pem" }) as string,
  };
}
