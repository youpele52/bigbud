import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const protocol = "bigbud.thread.encrypted.v1";
const aad = (direction: "request" | "response") => Buffer.from(`${protocol}:${direction}`);
const keyFor = (privateKey: string, publicKey: string, nonce: string) => {
  const peer = createPublicKey({
    key: Buffer.from(publicKey, "base64url"),
    type: "spki",
    format: "der",
  });
  if (peer.asymmetricKeyType !== "x25519") throw new Error("V2 callback encryption peer rejected.");
  return Buffer.from(
    hkdfSync(
      "sha256",
      diffieHellman({ privateKey: createPrivateKey(privateKey), publicKey: peer }),
      Buffer.from(nonce, "base64url"),
      aad("request"),
      32,
    ),
  );
};
interface Envelope {
  protocol: string;
  ephemeralKey: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

/** Authenticate/decrypt before looking at callback credentials; forged endpoints only see fresh ciphertext. */
export function openV2ThreadEncryptedRequest(value: unknown, privateKey: string) {
  try {
    const input = value as Envelope;
    if (
      !input ||
      Object.keys(input).toSorted().join() !== "ciphertext,ephemeralKey,iv,protocol,tag" ||
      input.protocol !== protocol ||
      typeof input.ephemeralKey !== "string" ||
      !/^[A-Za-z0-9_-]{59}$/.test(input.ephemeralKey) ||
      typeof input.iv !== "string" ||
      !/^[A-Za-z0-9_-]{16}$/.test(input.iv) ||
      typeof input.tag !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/.test(input.tag) ||
      typeof input.ciphertext !== "string" ||
      !/^[A-Za-z0-9_-]{1,30000}$/.test(input.ciphertext)
    )
      throw new Error("envelope");
    const key = keyFor(privateKey, input.ephemeralKey, input.iv);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(input.iv, "base64url"));
    decipher.setAAD(aad("request"));
    decipher.setAuthTag(Buffer.from(input.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(input.ciphertext, "base64url")),
      decipher.final(),
    ]);
    if (plaintext.length > 22000) throw new Error("bound");
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as {
      token: string;
      payload: unknown;
    };
    if (
      !decoded ||
      Object.keys(decoded).toSorted().join() !== "payload,token" ||
      typeof decoded.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(decoded.token)
    )
      throw new Error("input");
    return {
      ...decoded,
      seal(result: unknown) {
        const content = Buffer.from(JSON.stringify(result));
        if (content.length > 95000)
          throw new Error("V2 encrypted callback response bound rejected.");
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(aad("response"));
        return {
          protocol,
          iv: iv.toString("base64url"),
          ciphertext: Buffer.concat([cipher.update(content), cipher.final()]).toString("base64url"),
          tag: cipher.getAuthTag().toString("base64url"),
        };
      },
    };
  } catch {
    throw new Error("V2 encrypted callback envelope rejected.");
  }
}
