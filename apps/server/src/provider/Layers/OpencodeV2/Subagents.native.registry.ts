/** Pinned public Promise plugin/storage/RPC APIs only; no private Core services or fabricated endpoints. */
export function renderV2NativeFamilyRegistry(publicKey: string, issuer: string): string {
  return `import {createPublicKey,verify,randomBytes,createHash} from "node:crypto";
import {sealRequest} from "./crypto.mjs";
const protocol="bigbud.native-subagents.v1", issuer=${JSON.stringify(issuer)}, key=createPublicKey(${JSON.stringify(publicKey)});
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id=value=>typeof value==="string"&&value.length>0&&Buffer.byteLength(value)<=4096;
export function fail(){throw new Error("V2 native family authority rejected.");}
export function registry(ctx,lifetime){
 const roots=new Map(),pending=new Map(),writes=new Map(),requests=new Map();
 async function lineage(sessionID){
  let native=await ctx.session.get({sessionID});
  if(native.metadata?.bigbud_provider!=="opencodeV2"||native.metadata.bigbud_issuer!==issuer)return;
  const seen=new Set();
  for(let depth=0;depth<=16;depth++){
   if(seen.has(native.id)||native.fork||native.location.directory!==ctx.location.directory)fail();seen.add(native.id);
   if(!native.parentID)return native;
   native=await ctx.session.get({sessionID:native.parentID});
   if(native.metadata?.bigbud_provider!=="opencodeV2"||native.metadata.bigbud_issuer!==issuer)fail();
  }fail();
 }
 async function locate(sessionID){
  const native=await lineage(sessionID);
  if(!native){
   if(roots.has(sessionID)||[...roots.values()].some(entry=>entry.children[sessionID])||await ctx.storage.get("root/"+sessionID)||await ctx.storage.get("child/"+sessionID))fail();
   return;
  }
  let entry=roots.get(native.id);
  if(!entry){const stored=await ctx.storage.get("root/"+native.id);if(!stored)fail();entry={...stored,controller:new AbortController()};if(roots.size>=32)fail();roots.set(native.id,entry);}
  const owner=entry.owner;
  if(owner.rootId!==native.id||owner.threadId!==native.metadata.bigbud_thread||owner.storageIdentity!==native.metadata.bigbud_storage||owner.directory!==native.location.directory)fail();
  return entry;
 }
 function current(entry,generation=entry.generation){if(lifetime.signal.aborted||entry.controller.signal.aborted||entry.fenced||entry.generation!==generation||entry.owner.expires<=Date.now())fail();}
 async function save(entry){
  const id=entry.owner.rootId,previous=writes.get(id)??Promise.resolve();
  const operation=previous.catch(()=>{}).then(async()=>{const {controller,...stored}=entry;await ctx.storage.set("root/"+id,JSON.parse(JSON.stringify(stored)));});writes.set(id,operation);
  try{await operation;}catch(error){entry.fenced=true;entry.stopped=true;entry.controller.abort();throw error;}finally{if(writes.get(id)===operation)writes.delete(id);}
 }
 async function callback(entry,kind,sessionId,payload,signal){
   const owner=entry.owner,request={protocol,nonce:owner.nonce,rootId:owner.rootId,epoch:owner.epoch,transportGeneration:owner.transportGeneration,generation:entry.generation,sessionId,requestNonce:randomBytes(16).toString("hex"),expires:Date.now()+5000,kind,payload};
  const encrypted=sealRequest({token:owner.callbackToken,payload:request});
  const response=await fetch(owner.callbackUrl,{method:"POST",redirect:"error",headers:{"content-type":"application/json"},body:JSON.stringify(encrypted.body),signal:AbortSignal.any([lifetime.signal,entry.controller.signal,AbortSignal.timeout(5000),...(signal?[signal]:[])])});
  if(!response.ok||!response.body)fail();const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>131072)fail();chunks.push(part.value);}}finally{await reader.cancel();}
  const reply=encrypted.open(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))));
  if(reply.requestNonce!==request.requestNonce||typeof reply.signature!=="string"||!verify(null,Buffer.from(JSON.stringify([protocol,owner.nonce,request.requestNonce,hash(request),reply.result])),key,Buffer.from(reply.signature,"base64url")))fail();
  return reply.result;
 }
 function authenticated(input,method){
  if(!input||Object.keys(input).sort().join()!=="body,expires,method,protocol,requestId,signature"||input.protocol!==protocol||input.method!==method||!Number.isSafeInteger(input.expires)||input.expires<=Date.now()||input.expires>Date.now()+15000||!id(input.requestId)||Buffer.byteLength(JSON.stringify(input))>32768)fail();
  if(!verify(null,Buffer.from(JSON.stringify([input.protocol,input.method,input.requestId,input.expires,input.body])),key,Buffer.from(input.signature??"","base64url")))fail();return input.body;
 }
 async function mutate(method,input,fenceRevision){
  const body=authenticated(input,method),native=await lineage(body.rootId);if(!native||native.id!==body.rootId)fail();
  let entry=roots.get(native.id);if(!entry){const stored=await ctx.storage.get("root/"+native.id);if(stored)entry={...stored,controller:new AbortController()};}
  if(method==="enroll"){
   if(![body.rootId,body.storageIdentity,body.threadId,body.directory,body.transportGeneration,body.nonce,body.callbackToken,body.callbackUrl].every(id)||!Number.isSafeInteger(body.generation)||body.generation<0||!Number.isSafeInteger(body.epoch)||body.epoch<0||body.expires<=Date.now()||body.expires>Date.now()+60000)fail();
   const url=new URL(body.callbackUrl);if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||!url.port||url.pathname!=="/invoke"||url.search||url.hash||url.username||url.password)fail();
   if(native.metadata.bigbud_storage!==body.storageIdentity||native.metadata.bigbud_thread!==body.threadId||native.location.directory!==body.directory)fail();
   if(entry&&(body.generation<entry.generation||(entry.owner.nonce!==body.nonce&&entry.owner.expires>Date.now())))fail();
    if(entry&&entry.owner.nonce===body.nonce){if(body.generation!==entry.generation)fail();entry.owner=body;if(entry.controller.signal.aborted)entry.controller=new AbortController();}
    else {if(roots.size>=32&&!roots.has(native.id))fail();entry={owner:body,generation:body.generation,fenceRevision:entry?.fenceRevision??0,fenced:true,stopped:entry?.stopped??false,children:entry?.children??{},input:entry?.input??null,controller:new AbortController()};}
   const proof=await callback(entry,"probe",native.id,{});if(proof.active!==true)fail();
   if(ctx.session.family?.abi==="opencode.native-family.v1"){
    try{entry.nativeFamily=await ctx.session.family.inspect({rootID:native.id,generation:entry.generation});}
    catch{entry.nativeFamily=await ctx.session.family.register({rootID:native.id,generation:entry.generation,inputID:entry.input?.id??entry.owner.nonce});}
    if(entry.nativeFamily.stopped){entry.stopped=true;entry.fenced=true;}
   }
   await save(entry);roots.set(native.id,entry);
  }else{
   if(!entry||entry.owner.nonce!==body.nonce)fail();
    if(method==="fence"){entry.fenceRevision=(entry.fenceRevision??0)+1;entry.fenced=true;entry.stopped=true;entry.owner.expires=Date.now();entry.controller.abort();
     if(ctx.session.family?.abi==="opencode.native-family.v1")entry.nativeFamily=await ctx.session.family.stop({rootID:native.id,generation:entry.generation});
     await save(entry);}
    else if(method==="authorize"){
     if(fenceRevision!==(entry.fenceRevision??0))fail();
    if(!id(body.inputId)||!id(body.fingerprint)||!Number.isSafeInteger(body.generation)||body.generation<entry.generation||body.generation>entry.generation+1)fail();
     if(entry.fenced&&entry.stopped&&body.generation!==entry.generation+1)fail();
     if(!Number.isSafeInteger(body.leaseExpires)||body.leaseExpires<=Date.now()||body.leaseExpires>Date.now()+60000)fail();entry.owner.expires=body.leaseExpires;
     if(ctx.session.family?.abi==="opencode.native-family.v1")entry.nativeFamily=await ctx.session.family.register({rootID:native.id,generation:body.generation,inputID:body.inputId});
     if(fenceRevision!==(entry.fenceRevision??0))fail();
     entry.generation=body.generation;entry.input={id:body.inputId,fingerprint:body.fingerprint};entry.fenced=false;entry.stopped=false;entry.controller=new AbortController();await save(entry);
   }else if(method==="receipt"){
    current(entry);if(ctx.session.family?.abi!=="opencode.native-family.v1"||!id(body.inputID))fail();
    return ctx.session.family.receipt({rootID:native.id,generation:entry.generation,inputID:body.inputID});
   }else if(method!=="inspect")fail();
   if(method==="inspect"&&ctx.session.family?.abi==="opencode.native-family.v1")entry.nativeFamily=await ctx.session.family.inspect({rootID:native.id,generation:entry.generation});
  }
   return {nonce:entry.owner.nonce,generation:entry.generation,fenced:entry.fenced,stopped:entry.stopped===true,inputId:entry.input?.id??null,...(entry.nativeFamily?{nativeFamily:entry.nativeFamily}:{})};
 }
 async function run(method,input){
  const body=authenticated(input,method);if(!id(body.rootId))fail();
  for(const [id,expires] of requests)if(expires<=Date.now())requests.delete(id);
  if(requests.has(input.requestId)||requests.size>=4096)fail();requests.set(input.requestId,input.expires);
  const entry=roots.get(body.rootId),fenceRevision=entry?.fenceRevision??0;
  if(method==="fence"&&entry&&entry.owner.nonce===body.nonce){entry.fenceRevision=fenceRevision+1;entry.fenced=true;entry.stopped=true;entry.controller.abort();}
  if(pending.size>=32&&!pending.has(body.rootId))fail();
  const previous=pending.get(body.rootId)??Promise.resolve();
  const operation=previous.catch(()=>{}).then(()=>mutate(method,input,fenceRevision));pending.set(body.rootId,operation);
  try{return await operation;}finally{if(pending.get(body.rootId)===operation)pending.delete(body.rootId);}
 }
 return {locate,current,save,callback,run};
}
`;
}
