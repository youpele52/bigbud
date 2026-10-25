import { V2_THREAD_OWNER_FIELDS, V2_ENROLLMENT_PROTOCOL } from "./Orchestration.protocol.ts";
import {
  V2_COMPATIBILITY_DIGEST,
  V2_BOOTSTRAP_COMPATIBILITY,
} from "./Orchestration.compatibility.ts";

/** Emit only portable Node primitives, with the exact same signing-field order as the app. */
export function renderV2ThreadIdentity(publicKey: string): string {
  return `import {createHash, createPublicKey, randomBytes, verify} from "node:crypto";
import {sealRequest} from "./crypto.mjs";
export const protocol = ${JSON.stringify(V2_ENROLLMENT_PROTOCOL)};
const fields = ${JSON.stringify(V2_THREAD_OWNER_FIELDS)};
const key = createPublicKey(${JSON.stringify(publicKey)});
export const issuer = createHash("sha256").update(key.export({type:"spki",format:"der"})).digest("hex");
export function fail() { throw new Error("Required bigbud thread-tools integration rejected."); }
export function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function ownerDigest(owner) { return hash(fields.map(field => owner[field])); }
function bounded(value, limit=4096) { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= limit; }
function hex(value, length) { return typeof value === "string" && new RegExp("^[a-f0-9]{"+length+"}$").test(value); }
export function validateOwner(owner, artifact) {
  if (!owner || typeof owner !== "object" || Object.keys(owner).length !== fields.length || fields.some(field => !(field in owner))) fail();
  if (owner.protocol !== protocol || owner.issuer !== issuer || owner.bootstrapDigest !== artifact || !hex(artifact,64) || owner.bootstrapAbi!==${JSON.stringify(V2_BOOTSTRAP_COMPATIBILITY.bootstrapAbi)} || owner.compatibilityDigest!==${JSON.stringify(V2_COMPATIBILITY_DIGEST)} || !hex(owner.implementationDigest,64) || !hex(owner.enrollmentNonce,32) || !hex(owner.callbackToken,64)) fail();
  if (["threadId","nativeSessionId","storageIdentity","directory","transportGeneration","callbackUrl"].some(field => !bounded(owner[field]))) fail();
  if (owner.runtimeTargetId !== "local" || owner.workspaceTargetId !== "local" || [owner.sessionEpoch,owner.consentRevision].some(value => !Number.isSafeInteger(value) || value < 0)) fail();
  let url; try { url=new URL(owner.callbackUrl); } catch { fail(); }
  if(url.protocol!=="http:" || url.hostname!=="127.0.0.1" || !url.port || Number(url.port)>65535 || url.username || url.password || url.pathname!=="/invoke" || url.search || url.hash || url.href!==owner.callbackUrl) fail();
}
export function authenticate(input, operation, now=Date.now()) {
  const expected = ["protocol","operation","issuer","ownerDigest","enrollmentNonce","requestId","authExpiresAt","leaseRevision","leaseExpiresAt","owner","signature"];
  if(Buffer.byteLength(JSON.stringify(input)??"")>32768) fail();
  if (!input || typeof input !== "object" || Object.keys(input).length !== expected.length || expected.some(field => !(field in input))) fail();
  if (input.protocol !== protocol || input.operation !== operation || input.issuer !== issuer || !hex(input.ownerDigest,64) || !hex(input.enrollmentNonce,32) || !hex(input.requestId,32)) fail();
  if (!Number.isSafeInteger(input.authExpiresAt) || input.authExpiresAt <= now || input.authExpiresAt > now + 15000 || typeof input.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(input.signature)) fail();
  const lease = operation === "enroll" || operation === "renew";
  if (lease ? !Number.isSafeInteger(input.leaseRevision) || input.leaseRevision < 1 || !Number.isSafeInteger(input.leaseExpiresAt) || input.leaseExpiresAt <= now || input.leaseExpiresAt > now+60000 || input.leaseExpiresAt > input.authExpiresAt+60000 : input.leaseRevision !== null || input.leaseExpiresAt !== null) fail();
  if (operation === "enroll" ? !input.owner : input.owner !== null) fail();
  const bytes = Buffer.from(JSON.stringify([input.protocol,input.operation,input.issuer,input.ownerDigest,input.enrollmentNonce,input.requestId,input.authExpiresAt,input.leaseRevision,input.leaseExpiresAt,input.owner ? fields.map(field=>input.owner[field]) : null]));
  if (!verify(null,bytes,key,Buffer.from(input.signature,"base64url"))) fail();
  return input;
}
export async function callback(owner, payload, signal, timeout=5000, lease) {
  try {
  const requestNonce=randomBytes(16).toString("hex");
   const request={...payload,requestNonce,leaseRevision:lease?.revision,leaseExpiresAt:lease?.expiry};
   const encrypted=sealRequest({token:owner.callbackToken,payload:request}), body=JSON.stringify(encrypted.body); if(Buffer.byteLength(body)>32768) fail();
   const response = await fetch(owner.callbackUrl,{method:"POST",redirect:"error",headers:{"content-type":"application/json"},body,signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)});
  const reader = response.body?.getReader(); if (!reader) fail();
  const chunks=[]; let bytes=0;
  try { for (;;) { const part=await reader.read(); if(part.done) break; bytes+=part.value.length; if(bytes>131072) fail(); chunks.push(part.value); } } finally { await reader.cancel(); }
  if(!response.ok) fail();
   const reply=encrypted.open(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))));
   if(!reply || Object.keys(reply).sort().join()!=="acknowledgedExpiry,acknowledgedRevision,enrollmentNonce,leaseExpiresAt,leaseRevision,operation,ownerDigest,requestDigest,requestNonce,result,signature" || reply.ownerDigest!==ownerDigest(owner) || reply.enrollmentNonce!==owner.enrollmentNonce || reply.requestNonce!==requestNonce || reply.leaseRevision!==request.leaseRevision || reply.leaseExpiresAt!==request.leaseExpiresAt || reply.acknowledgedRevision!==lease?.revision || reply.acknowledgedExpiry!==lease?.expiry || reply.operation!==request.kind || reply.requestDigest!==hash(request) || typeof reply.signature!=="string" || !/^[A-Za-z0-9_-]{86}$/.test(reply.signature)) fail();
  const resultDigest=createHash("sha256").update(JSON.stringify(reply.result)).digest("hex");
   if(!verify(null,Buffer.from(JSON.stringify(["callback-response",reply.ownerDigest,reply.enrollmentNonce,requestNonce,request.leaseRevision,request.leaseExpiresAt,reply.acknowledgedRevision,reply.acknowledgedExpiry,request.kind,reply.requestDigest,resultDigest])),key,Buffer.from(reply.signature,"base64url"))) fail();
  return reply.result;
  } catch { fail(); }
}
export function verifyProof(owner, revision, expiry, challenge, signature) {
  if(typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) fail();
  if(!verify(null,Buffer.from(JSON.stringify(["callback-proof",ownerDigest(owner),revision,expiry,challenge])),key,Buffer.from(signature,"base64url"))) fail();
}
`;
}
