/** Portable native encryption uses only Node primitives available in the qualified Node/Bun hosts. */
export function renderV2ThreadCrypto(publicKey: string): string {
  return `import {createCipheriv,createDecipheriv,createPublicKey,diffieHellman,generateKeyPairSync,hkdfSync,randomBytes} from "node:crypto";
const protocol="bigbud.thread.encrypted.v1", peer=createPublicKey(${JSON.stringify(publicKey)});
const aad=direction=>Buffer.from(protocol+":"+direction);
export function sealRequest(value) {
  const plaintext=Buffer.from(JSON.stringify(value)); if(plaintext.length>22000) throw new Error("Required bigbud thread-tools payload bound rejected.");
  const ephemeral=generateKeyPairSync("x25519"), iv=randomBytes(12);
  const key=Buffer.from(hkdfSync("sha256",diffieHellman({privateKey:ephemeral.privateKey,publicKey:peer}),iv,aad("request"),32));
  const cipher=createCipheriv("aes-256-gcm",key,iv); cipher.setAAD(aad("request"));
  const body={protocol,ephemeralKey:ephemeral.publicKey.export({type:"spki",format:"der"}).toString("base64url"),iv:iv.toString("base64url"),ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final()]).toString("base64url"),tag:cipher.getAuthTag().toString("base64url")};
  return {body,open(reply) {
    if(!reply || Object.keys(reply).sort().join()!=="ciphertext,iv,protocol,tag" || reply.protocol!==protocol || typeof reply.iv!=="string" || !/^[A-Za-z0-9_-]{16}$/.test(reply.iv) || typeof reply.tag!=="string" || !/^[A-Za-z0-9_-]{22}$/.test(reply.tag) || typeof reply.ciphertext!=="string" || !/^[A-Za-z0-9_-]{1,126667}$/.test(reply.ciphertext)) throw new Error("Required bigbud thread-tools encrypted response rejected.");
    const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(reply.iv,"base64url")); decipher.setAAD(aad("response")); decipher.setAuthTag(Buffer.from(reply.tag,"base64url"));
    const content=Buffer.concat([decipher.update(Buffer.from(reply.ciphertext,"base64url")),decipher.final()]); if(content.length>95000) throw new Error("Required bigbud thread-tools response bound rejected.");
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(content));
  }};
}
`;
}
