/** Native ABI is a separate registration; the frozen thread bootstrap is never modified. */
export function renderV2NativeFamilyPlugin(issuer: string): string {
  return `import {randomBytes,createHash} from "node:crypto";
import {registry,fail} from "./registry.mjs";
const protocol="bigbud.native-subagents.v1",rpcID=protocol+".${issuer}";
const artifact=new URL(import.meta.url).pathname.split("/").at(-2),setupInstanceId=randomBytes(16).toString("hex");
export default {id:rpcID,async setup(ctx){
 if(!/^[a-f0-9]{64}$/.test(artifact)||![ctx.tool?.transform,ctx.permission?.hook,ctx.session?.hook,ctx.storage?.get,ctx.storage?.set,ctx.rpc?.register].every(value=>typeof value==="function"))fail();
 const lifetime=new AbortController(),state=registry(ctx,lifetime),registrations=[];
 try{
 registrations.push(await ctx.tool.transform(editor=>{
  if(typeof editor.get!=="function"||typeof editor.update!=="function"||!editor.get("subagent"))fail();
  editor.update("subagent",tool=>{const original=tool.execute;if(typeof original!=="function")fail();
   tool.execute=async function(input,context){
    const entry=await state.locate(context.sessionID);if(!entry)return original.call(this,input,context);
    const generation=entry.generation;state.current(entry,generation);
    await state.callback(entry,"spawn",context.sessionID,{continuationId:input.sessionID??null,messageId:context.messageID,callId:context.id,background:input.background===true},context.signal);state.current(entry,generation);
    let childID;
    const progress=async metadata=>{
     state.current(entry,generation);
     if(typeof metadata?.sessionID!=="string")fail();
     const native=await ctx.session.get({sessionID:metadata.sessionID});state.current(entry,generation);
     if(native.parentID!==context.sessionID||native.fork||native.location.directory!==ctx.location.directory)fail();
     await state.callback(entry,"enroll-child",context.sessionID,{sessionID:metadata.sessionID,parentSessionID:context.sessionID,messageID:context.messageID,callID:context.id,agent:input.agent,description:input.description,prompt:input.prompt,background:input.background===true},context.signal);state.current(entry,generation);
     childID=native.id;
     if(Object.keys(entry.children).length>=128&&!entry.children[native.id])fail();
     entry.children[native.id]={generation,pendingPrompt:true};await state.save(entry);state.current(entry,generation);
     await ctx.storage.set("child/"+native.id,{rootId:entry.owner.rootId,generation});state.current(entry,generation);
     await context.progress(metadata);state.current(entry,generation);
    };
    const receipt=createHash("sha256").update(JSON.stringify([generation,context.sessionID,context.messageID,context.id])).digest("hex");
    let result;
    try{result=await original.call(this,input,{...context,progress});}
    catch(error){if(childID)await state.callback(entry,"executor-settled",childID,{receipt,status:"uncertain"},context.signal);throw error;}
    state.current(entry,generation);if(!childID)fail();
    const status=result?.output?.status;
    await state.callback(entry,"executor-settled",childID,{receipt,status:status==="completed"?"completed":status==="running"?"running":"uncertain"},context.signal);
    state.current(entry,generation);return result;
   };
  });
 }));
 registrations.push(await ctx.permission.hook("evaluate",async event=>{
  const entry=await state.locate(event.sessionID);if(!entry)return;const generation=entry.generation;state.current(entry,generation);
  if(event.sessionID!==entry.owner.rootId&&entry.children[event.sessionID]?.generation!==generation)fail();
  const result=await state.callback(entry,"permission",event.sessionID,{action:event.action,resources:event.resources,nativeEffect:event.effect,agent:event.agent??null});state.current(entry,generation);
  const rank={allow:0,ask:1,deny:2};if(rank[event.effect]===undefined||rank[result.effect]===undefined)fail();
  if(rank[result.effect]>rank[event.effect])event.effect=result.effect;
 }));
 registrations.push(await ctx.session.hook("prompt",async event=>{
  const entry=await state.locate(event.sessionID);if(!entry)return;const generation=entry.generation;state.current(entry,generation);
  if(event.sessionID===entry.owner.rootId){if(event.messageID!==entry.input?.id||event.metadata?.bigbud_fingerprint!==entry.input?.fingerprint)fail();}
  else {const child=entry.children[event.sessionID];if(!child||child.generation!==generation||!child.pendingPrompt)fail();child.pendingPrompt=false;await state.save(entry);}
  await state.callback(entry,"prompt",event.sessionID,{inputId:event.messageID,fingerprint:event.metadata?.bigbud_fingerprint??null});state.current(entry,generation);
  event.metadata={...event.metadata,bigbud_family_generation:generation,bigbud_family_root:entry.owner.rootId};
 }));
 for(const kind of ["context","compaction","generate","title"])registrations.push(await ctx.session.hook(kind,async event=>{
  const entry=await state.locate(event.sessionID);if(!entry)return;const generation=entry.generation;state.current(entry,generation);
  if(kind!=="context")fail();
  const messages=await ctx.session.context({sessionID:event.sessionID});if(!Array.isArray(messages)||messages.length>1000||Buffer.byteLength(JSON.stringify(messages))>2000000)fail();
  const latest=messages.findLast(message=>["user","synthetic","shell","skill"].includes(message.type));
  if(latest?.type==="synthetic"){
   if(ctx.session.family?.abi!=="opencode.native-family.v1")fail();
   const proof=await ctx.session.family.receipt({rootID:entry.owner.rootId,generation,inputID:latest.id});
   state.current(entry,generation);
   if(proof.consumed||proof.parentID!==event.sessionID||proof.notificationID!==latest.id||proof.generation!==generation||entry.children[proof.childID]?.generation!==generation)fail();
   await state.callback(entry,"context",event.sessionID,{inputId:latest.id,nativeCompletion:true});state.current(entry,generation);return;
  }
  if(!latest||latest.type!=="user"||latest.metadata?.bigbud_family_generation!==generation||latest.metadata?.bigbud_family_root!==entry.owner.rootId)fail();
  if(event.sessionID===entry.owner.rootId&&latest.id!==entry.input?.id)fail();
  if(event.sessionID!==entry.owner.rootId&&entry.children[event.sessionID]?.generation!==generation)fail();
  await state.callback(entry,"context",event.sessionID,{inputId:latest.id,fingerprint:latest.metadata?.bigbud_fingerprint??null});state.current(entry,generation);
 }));
 const object={type:"object",additionalProperties:true};
 registrations.push(await ctx.rpc.register({id:rpcID,events:{},methods:Object.fromEntries(["info","enroll","authorize","fence","inspect","receipt"].map(method=>[method,{input:object,output:object}]))},{
  info:async()=>({protocol,artifactDigest:artifact,setupInstanceId,nativeVersion:ctx.app.version,...(ctx.session.family?{familyABI:ctx.session.family.abi,familySourceDigest:ctx.session.family.sourceDigest}:{})}),
  ...Object.fromEntries(["enroll","authorize","fence","inspect","receipt"].map(method=>[method,input=>state.run(method,input)]))
 }));
 }catch(error){lifetime.abort();for(const registration of registrations.toReversed())await registration.dispose();throw error;}
 return async()=>{lifetime.abort();for(const registration of registrations.toReversed())await registration.dispose();};
}};
`;
}
