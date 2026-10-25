import {
  V2_SCOPED_NATIVE_SESSION_PREFIX,
  V2_COMPACT_NATIVE_SESSION_PREFIX,
} from "./Orchestration.sessionIdentity.ts";

/** Enrollment changes are atomic after proof; revoke never waits behind a renewal. */
export function renderV2ThreadRegistry(): string {
  return `import {randomBytes} from "node:crypto";
import {issuer,authenticate,validateOwner,ownerDigest,callback,verifyProof,fail} from "./identity.mjs";
import {legacyCleanupRegistry} from "./legacy.mjs";
export function registry(ctx, artifact, lifetime) {
  const legacyCleanup=legacyCleanupRegistry();
  const owners=new Map(), managed=new Set(), tombstones=new Map(), pending=new Map(); let active=0;
  const sessionPrefix=${JSON.stringify(V2_SCOPED_NATIVE_SESSION_PREFIX)}+issuer+"_";
  const compactPrefix=${JSON.stringify(V2_COMPACT_NATIVE_SESSION_PREFIX)}+Buffer.from(issuer,"hex").toString("base64url")+"_";
  function namespaced(sessionID) { return typeof sessionID==="string" && ((sessionID.startsWith(sessionPrefix) && /^[a-f0-9]{64}$/.test(sessionID.slice(sessionPrefix.length))) || (sessionID.startsWith(compactPrefix) && /^[A-Za-z0-9_-]{43}$/.test(sessionID.slice(compactPrefix.length)))); }
  function prune() { for(const [nonce,value] of tombstones) if(value.until<=Date.now()) tombstones.delete(nonce); }
  function exact(input) {
    const entry=owners.get(input.enrollmentNonce);
    if(entry && entry.digest!==input.ownerDigest) fail();
    return entry;
  }
  function result(entry) { return {state:entry.revoked ? "revoked" : entry.expiry<=Date.now() ? "expired" : "active",ownerDigest:entry.digest,enrollmentNonce:entry.owner.enrollmentNonce,revision:entry.revision,expiry:entry.expiry}; }
  function current(sessionID) {
    return [...owners.values()].find(entry=>entry.owner.nativeSessionId===sessionID && !entry.revoked && entry.expiry>Date.now());
  }
  async function verifyNative(owner, signal) {
    if(owner.nativeSessionId.startsWith(${JSON.stringify(V2_COMPACT_NATIVE_SESSION_PREFIX)}) && !namespaced(owner.nativeSessionId)) fail();
    signal?.throwIfAborted();
    const native=await ctx.session.get({sessionID:owner.nativeSessionId},{signal});
    signal?.throwIfAborted();
    if(native.id!==owner.nativeSessionId || native.parentID || native.fork || native.location.directory!==owner.directory || ctx.location.directory!==owner.directory || native.metadata?.bigbud_provider!=="opencodeV2" || native.metadata.bigbud_thread!==owner.threadId || native.metadata.bigbud_storage!==owner.storageIdentity) fail();
    if(native.metadata.bigbud_issuer!==owner.issuer || native.metadata.bigbud_registration!=="scoped" || native.metadata.bigbud_identity!=="shared-api-v2") fail();
  }
  async function prove(owner, revision, expiry, signal) {
    const controller=new AbortController(), bounded=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
    let rejectAbort; const cancelled=new Promise((_,reject)=>{rejectAbort=()=>reject(new Error("Required bigbud thread-tools proof timed out/revoked."));});
    bounded.addEventListener("abort",rejectAbort,{once:true});
    const timeout=setTimeout(()=>controller.abort(),5000);
    const work=(async()=>{
      bounded.throwIfAborted(); await verifyNative(owner,bounded); bounded.throwIfAborted();
      const challenge=randomBytes(16).toString("hex");
      const reply=await callback(owner,{kind:"proof",ownerDigest:ownerDigest(owner),enrollmentNonce:owner.enrollmentNonce,revision,expiry,challenge},bounded,5000,{revision,expiry});
      bounded.throwIfAborted(); verifyProof(owner,revision,expiry,challenge,reply.signature);
    })();
    try { if(bounded.aborted) rejectAbort(); await Promise.race([work,cancelled]); }
    finally { clearTimeout(timeout); bounded.removeEventListener("abort",rejectAbort); controller.abort(); }
  }
  function revoke(input) {
    prune(); const entry=exact(input); const previous=tombstones.get(input.enrollmentNonce);
    if(previous && previous.digest!==input.ownerDigest) fail();
    if(!previous && tombstones.size>=128) fail();
    const until=Math.max(previous?.until??0,entry?.expiry??0,Date.now()+75000);
    tombstones.set(input.enrollmentNonce,{digest:input.ownerDigest,until});
    if(entry) { entry.revoked=true; entry.controller.abort(); }
    pending.get(input.enrollmentNonce)?.controller.abort();
    return {state:"revoked",ownerDigest:input.ownerDigest,enrollmentNonce:input.enrollmentNonce,revision:entry?.revision??0,expiry:entry?.expiry??0};
  }
  async function mutate(input, signal, controller) {
    prune(); const tomb=tombstones.get(input.enrollmentNonce);
    if(tomb) { if(tomb.digest===input.ownerDigest) tomb.until=Math.max(tomb.until,input.leaseExpiresAt); fail(); }
    let entry=exact(input);
    if(entry) {
      if(entry.revoked || entry.expiry<=Date.now()) fail();
      if(input.leaseRevision<entry.revision) return {...result(entry),state:"superseded"};
      if(input.leaseRevision===entry.revision) { if(input.leaseExpiresAt!==entry.expiry) fail(); return result(entry); }
      if(input.operation!=="renew" || input.leaseRevision!==entry.revision+1 || input.leaseExpiresAt<=entry.expiry) fail();
    } else if(input.operation!=="enroll" || input.leaseRevision!==1) fail();
    const owner=entry?.owner??input.owner;
    validateOwner(owner,artifact);
    if(owner.enrollmentNonce!==input.enrollmentNonce || ownerDigest(owner)!==input.ownerDigest) fail();
    if(!namespaced(owner.nativeSessionId) && !managed.has(owner.nativeSessionId) && managed.size>=32) fail();
    for(const other of owners.values()) if(other.owner.nativeSessionId===owner.nativeSessionId && other!==entry && !other.revoked && other.expiry>Date.now()) fail();
    if(!entry && owners.size>=32) { for(const [nonce,value] of owners) if(value.revoked || value.expiry<=Date.now()) owners.delete(nonce); if(owners.size>=32) fail(); }
    const cancelled=AbortSignal.any([controller.signal,lifetime.signal,...(entry?[entry.controller.signal]:[]),...(signal?[signal]:[])]);
    const expectedRevision=entry?.revision;
    await prove(owner,input.leaseRevision,input.leaseExpiresAt,cancelled);
    cancelled.throwIfAborted();
    if(tombstones.has(input.enrollmentNonce) || (entry && (entry.revoked || entry.expiry<=Date.now() || entry.revision!==expectedRevision)) || (!entry && owners.has(input.enrollmentNonce))) fail();
    for(const other of owners.values()) if(other.owner.nativeSessionId===owner.nativeSessionId && other!==entry && !other.revoked && other.expiry>Date.now()) fail();
    if(!entry && (owners.size>=32 || (!namespaced(owner.nativeSessionId) && !managed.has(owner.nativeSessionId) && managed.size>=32))) fail();
    if(!namespaced(owner.nativeSessionId)) managed.add(owner.nativeSessionId);
    if(!entry) { entry={owner,digest:input.ownerDigest,revision:0,expiry:0,revoked:false,controller}; owners.set(owner.enrollmentNonce,entry); }
    entry.revision=input.leaseRevision; entry.expiry=input.leaseExpiresAt;
    return result(entry);
  }
  async function run(operation, value, context) {
    if(value?.protocol==="bigbud.thread.v1") return legacyCleanup(value,operation);
    const input=authenticate(value,operation);
    if(operation==="enroll") { validateOwner(input.owner,artifact); if(ownerDigest(input.owner)!==input.ownerDigest || input.owner.enrollmentNonce!==input.enrollmentNonce) fail(); }
    if(operation==="detach") return revoke(input);
    if(operation==="inspect") { const entry=exact(input); const tomb=tombstones.get(input.enrollmentNonce); if(tomb && tomb.digest!==input.ownerDigest) fail(); return entry ? result(entry) : {state:tomb?"revoked":"missing",ownerDigest:input.ownerDigest,enrollmentNonce:input.enrollmentNonce,revision:0,expiry:0}; }
    if(active>=16) fail();
    const key=input.enrollmentNonce;
    const signature=JSON.stringify([input.ownerDigest,input.leaseRevision,input.leaseExpiresAt]);
    const existing=pending.get(key); if(existing) { if(existing.signature!==signature) fail(); return existing.operation; }
    active++;
    const controller=new AbortController();
    const operationPromise=mutate(input,context.signal,controller);
    pending.set(key,{signature,operation:operationPromise,controller});
    try { return await operationPromise; } finally { pending.delete(key); active--; }
  }
  return {current,known(sessionID) { return namespaced(sessionID) || managed.has(sessionID); },run,close() { lifetime.abort(); for(const entry of owners.values()) { entry.revoked=true; entry.controller.abort(); } }};
}
`;
}
