import { V2_LEGACY_ENROLLMENT_PROTOCOL } from "./Orchestration.protocol.legacy.ts";

/** Exact L envelope/signature encoding, restricted to cleanup; never creates an N callback owner. */
export function renderV2LegacyCleanup(publicKey: string) {
  return `import {createPublicKey,verify} from "node:crypto";
import {issuer,fail} from "./identity.mjs";
const key=createPublicKey(${JSON.stringify(publicKey)}),protocol=${JSON.stringify(V2_LEGACY_ENROLLMENT_PROTOCOL)};
export function authenticateLegacyCleanup(input,operation,now=Date.now()) {
 const fields=["protocol","operation","issuer","ownerDigest","enrollmentNonce","requestId","authExpiresAt","leaseRevision","leaseExpiresAt","owner","signature"];
 if(!["inspect","detach"].includes(operation) || !input || typeof input!=="object" || Buffer.byteLength(JSON.stringify(input))>32768 || Object.keys(input).length!==fields.length || fields.some(field=>!Object.hasOwn(input,field)))fail();
 if(input.protocol!==protocol || input.operation!==operation || input.issuer!==issuer || !/^[a-f0-9]{64}$/.test(input.ownerDigest) || !/^[a-f0-9]{32}$/.test(input.enrollmentNonce) || !/^[a-f0-9]{32}$/.test(input.requestId))fail();
 if(input.owner!==null || input.leaseRevision!==null || input.leaseExpiresAt!==null || !Number.isSafeInteger(input.authExpiresAt) || input.authExpiresAt<=now || input.authExpiresAt>now+15000 || typeof input.signature!=="string" || !/^[A-Za-z0-9_-]{86}$/.test(input.signature))fail();
 const bytes=Buffer.from(JSON.stringify([input.protocol,input.operation,input.issuer,input.ownerDigest,input.enrollmentNonce,input.requestId,input.authExpiresAt,null,null,null]));
 if(!verify(null,bytes,key,Buffer.from(input.signature,"base64url")))fail();return input;
}
export function legacyCleanupRegistry() {
 const tombstones=new Map();
 return function run(value,operation){
  const input=authenticateLegacyCleanup(value,operation),key=JSON.stringify([input.protocol,input.ownerDigest,input.enrollmentNonce]);
  for(const [id,until]of tombstones)if(until<=Date.now())tombstones.delete(id);
  if(operation==="detach"){if(!tombstones.has(key)&&tombstones.size>=128)fail();tombstones.set(key,Date.now()+75000);}
  return{state:operation==="detach"||tombstones.has(key)?"revoked":"missing",ownerDigest:input.ownerDigest,enrollmentNonce:input.enrollmentNonce,revision:0,expiry:0};
 };
}
`;
}
