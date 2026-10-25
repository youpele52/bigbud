import { V2_NATIVE_BOOTSTRAP_SPECS } from "./Orchestration.plugin.specs.ts";
import {
  V2_COMPATIBILITY_DIGEST,
  V2_BOOTSTRAP_COMPATIBILITY,
} from "./Orchestration.compatibility.ts";
import { renderV2CanonicalCandidateGuard } from "./NativeCompatibility.version.ts";

/** Bootstrap public semantics are frozen; app implementation releases cannot change native registrations. */
export function renderV2ThreadPlugin(): string {
  const specs = V2_NATIVE_BOOTSTRAP_SPECS;
  return `import {randomBytes} from "node:crypto";
import {protocol,issuer,hash,callback,fail} from "./identity.mjs";
import {registry} from "./registry.mjs";
const artifact=new URL(import.meta.url).pathname.split("/").at(-2);
if(!/^[a-f0-9]{64}$/.test(artifact)) fail();
const pluginId="bigbud.thread.v2."+issuer;
const specs=${JSON.stringify(specs)}.map(spec=>({...spec,name:"bb2_"+issuer.slice(0,32)+"_"+spec.action}));
const object={type:"object",additionalProperties:true};
const envelope={type:"object",required:["protocol","operation","issuer","ownerDigest","enrollmentNonce","requestId","authExpiresAt","leaseRevision","leaseExpiresAt","owner","signature"],properties:Object.fromEntries(["protocol","operation","issuer","ownerDigest","enrollmentNonce","requestId","authExpiresAt","leaseRevision","leaseExpiresAt","owner","signature"].map(name=>[name,{}])),additionalProperties:false};
${renderV2CanonicalCandidateGuard()}
function id(value){return typeof value==="string"&&value.length>0&&Buffer.byteLength(value)<=4096;}
function registration(value){if(!value||typeof value.dispose!=="function")fail();return value;}
export default {id:pluginId,async setup(ctx) {
  if(!candidate(ctx?.app?.version)||!id(ctx?.location?.directory)||![ctx?.tool?.list,ctx?.tool?.transform,ctx?.session?.get,ctx?.session?.hook,ctx?.rpc?.register].every(value=>typeof value==="function"))fail();
  const lifetime=new AbortController(), owned=new Map(), registrations=[];
  const state=registry(ctx,artifact,lifetime);
  const setupInstanceId=randomBytes(16).toString("hex");
  const marker=" ["+pluginId+"/"+artifact+"/"+setupInstanceId+"]";
  async function healthy() {
    const tools=await ctx.tool.list();
    if(!Array.isArray(tools)||tools.length>1000)fail();
    for(const [name,fingerprint] of owned) { const tool=tools.find(item=>item.id===name); if(!tool || hash([tool.description,tool.input])!==fingerprint) fail(); }
  }
  try {
    registrations.push(registration(await ctx.tool.transform(editor=> {
      if(!editor||typeof editor.get!=="function"||typeof editor.add!=="function")fail();
      for(const spec of specs) if(editor.get(spec.name)) fail();
      for(const spec of specs) {
        const description=spec.description+marker;
        owned.set(spec.name,hash([description,spec.input]));
         editor.add({name:spec.name,description,input:spec.input,options:{codemode:false},async execute(input,context) {
          if(!context||![context.sessionID,context.messageID,context.id,context.agent].every(id)||!(context.signal instanceof AbortSignal))fail();
          await healthy();
          const entry=state.current(context.sessionID); if(!entry) fail();
          const signal=AbortSignal.any([context.signal,lifetime.signal,entry.controller.signal]);
           const result=await callback(entry.owner,{kind:"invoke",ownerDigest:entry.digest,enrollmentNonce:entry.owner.enrollmentNonce,sessionID:context.sessionID,messageID:context.messageID,callID:context.id,agent:context.agent,action:spec.action,input},signal,300000,entry);
           signal.throwIfAborted(); if(state.current(context.sessionID)!==entry) fail();
          return {content:JSON.stringify(result)};
        }});
      }
    })));
    for(const kind of ["context","generate","compaction"]) registrations.push(registration(await ctx.session.hook(kind,async event=> {
      if(!event||!id(event.sessionID)||!event.tools||typeof event.tools!=="object"||Array.isArray(event.tools)||Object.keys(event.tools).length>1000)fail();
      const entry=kind==="context" ? state.current(event.sessionID) : undefined;
      if(kind==="context" && state.known(event.sessionID)) await healthy();
      for(const [name,fingerprint] of owned) if(event.tools[name] && hash([event.tools[name].description,event.tools[name].input])===fingerprint && !entry) delete event.tools[name];
      if(kind==="context" && !entry && state.known(event.sessionID)) fail();
      if(entry) {
         const result=await callback(entry.owner,{kind:"status",ownerDigest:entry.digest,enrollmentNonce:entry.owner.enrollmentNonce},AbortSignal.any([lifetime.signal,entry.controller.signal]),5000,entry);
         if(result.active!==true || lifetime.signal.aborted || entry.controller.signal.aborted || state.current(event.sessionID)!==entry) fail();
      }
    })));
    registrations.push(registration(await ctx.rpc.register({id:"bigbud.thread.v2."+issuer,events:{},methods:Object.fromEntries(["info","enroll","renew","inspect","detach"].map(name=>[name,{input:name==="info"?{type:"object",properties:{},additionalProperties:false}:envelope,output:object}]))},{
      async info() { await healthy(); return {protocol:"bigbud.thread.v2."+issuer,enrollmentProtocol:protocol,issuer,artifactDigest:artifact,bootstrapDigest:artifact,bootstrapAbi:${JSON.stringify(V2_BOOTSTRAP_COMPATIBILITY.bootstrapAbi)},compatibilityDigest:${JSON.stringify(V2_COMPATIBILITY_DIGEST)},schemaDigest:${JSON.stringify(V2_BOOTSTRAP_COMPATIBILITY.schemaDigest)},setupInstanceId,nativeVersion:ctx.app.version,tools:specs.map(spec=>spec.name)}; },
      ...Object.fromEntries(["enroll","renew","inspect","detach"].map(name=>[name,(input,context)=>state.run(name,input,context)]))
    })));
  } catch(error) { state.close(); for(const registration of registrations.reverse()) await registration.dispose(); throw error; }
  return async()=> { state.close(); for(const registration of registrations.reverse()) await registration.dispose(); };
}};
`;
}
