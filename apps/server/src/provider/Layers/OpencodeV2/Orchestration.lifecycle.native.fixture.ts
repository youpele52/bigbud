import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpencodeV2Client } from "./Client.ts";

export interface V2LifecycleCounters {
  early: { setup: number; cleanup: number };
  sentinel: { setup: number; cleanup: number; started: number; aborted: number; settled: number };
  tools: Array<{ id: string; description: string; input: unknown }>;
}

/** Disposable native registrations expose counters, not native user configuration or history. */
function renderLifecycleProbe(id: "early" | "sentinel", revision: number) {
  return `// Owned disposable lifecycle probe revision ${revision}.
export default {id:"fixture.lifecycle.${id}",async setup(ctx){
const all=globalThis.__bigbudOwnedLifecycle??=new Map();
const state=all.get(ctx.location.directory)??{early:{setup:0,cleanup:0},sentinel:{setup:0,cleanup:0,started:0,aborted:0,settled:0}};
all.set(ctx.location.directory,state);state.${id}.setup++;
const lifetime=new AbortController(), registrations=[];
${
  id === "sentinel"
    ? `registrations.push(await ctx.tool.transform(editor=>editor.add({name:"lifecycle_pause",description:"Owned synthetic lifecycle pause",input:{type:"object",properties:{},additionalProperties:false},options:{codemode:false},async execute(_input,context){
state.sentinel.started++;const signal=AbortSignal.any([lifetime.signal,context.signal]);
try{await new Promise((resolve,reject)=>{const abort=()=>reject(new Error("Owned sentinel retired"));state.release=resolve;signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();});state.sentinel.settled++;return{content:"Owned lifecycle pause released"};}
catch(error){state.sentinel.aborted++;throw error;}
}})));
registrations.push(await ctx.rpc.register({id:"fixture.lifecycle",events:{},methods:{observe:{input:{type:"object",properties:{},additionalProperties:false},output:{type:"object",additionalProperties:true}},release:{input:{type:"object",properties:{},additionalProperties:false},output:{type:"object",additionalProperties:true}}}},{async observe(){const tools=await ctx.tool.list();return{early:state.early,sentinel:state.sentinel,tools:tools.filter(tool=>tool.id.startsWith("bigbud_thread_v1_")).map(({id,description,input})=>({id,description,input}))};},release(){state.release?.();return{ok:true};}}));`
    : ""
}
return async()=>{state.${id}.cleanup++;lifetime.abort();for(const registration of registrations.reverse())await registration.dispose();};
}};\n`;
}

/** Publish ordered probes exclusively in the fixture's isolated global configuration. */
export async function writeV2LifecycleProbes(configFile: string) {
  const directory = path.join(path.dirname(configFile), "plugins");
  await mkdir(directory, { mode: 0o700 });
  const early = path.join(directory, "aaa-lifecycle-early.js");
  const sentinel = path.join(directory, "zzz-lifecycle-sentinel.js");
  await writeFile(early, renderLifecycleProbe("early", 1), { mode: 0o600, flag: "wx" });
  await writeFile(sentinel, renderLifecycleProbe("sentinel", 1), { mode: 0o600, flag: "wx" });
  return {
    directory,
    early,
    sentinel,
    async changeEarly() {
      await writeFile(early, renderLifecycleProbe("early", 2), { mode: 0o600 });
    },
  };
}

export async function readV2LifecycleCounters(client: OpencodeV2Client, directory: string) {
  const result = await client.rpc.call(
    { rpcID: "fixture.lifecycle", method: "observe", input: {}, location: { directory } },
    { signal: AbortSignal.timeout(5000) },
  );
  return result.output as V2LifecycleCounters;
}
