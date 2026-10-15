import { V2_PREVIOUS_CODING_REQUEST_SCHEMA } from "./Coding.plugin.previous.schema.ts";
const fields = {
  path: { type: "string" },
  content: { type: "string" },
  oldText: { type: "string" },
  newText: { type: "string" },
  command: { type: "string" },
  request: V2_PREVIOUS_CODING_REQUEST_SCHEMA,
};

/** Frozen native-access-era template, accepted only for byte-exact owned upgrades. Never install it. */
export function renderV2PreviousCodingPlugin(url: string, token: string) {
  return `// bigbud-coding-owned-v1 ${JSON.stringify({ url, token })}
export default {id: "bigbud.coding.v1", async setup(ctx) {
    await ctx.tool.transform(editor => {
      for (const action of ${JSON.stringify(["read", "list", "write", "edit", "skill", "check", "shell", "orchestration"])}) editor.add({
        name: "bigbud_" + action,
        description: "Once-approved bigbud " + action + ". File actions use relative no-symlink paths. shell runs the exact command under macOS kernel filesystem/network isolation with fork denied: use shell builtins or exec a project interpreter; no pipelines/background descendants. orchestration accepts a canonical thread-tools request including create_thread/send_thread_message/get_status/workspace/browser: delegated threads use bigbud admission/ownership, never native fork. Native plugins/metadata/shell builtins remain denied.",
        input: {type: "object", properties: ${JSON.stringify(fields)}, required: action === "shell" ? ["command"] : action === "orchestration" ? ["request"] : ["path"], additionalProperties: false},
        options: {permission: "bigbud_coding", codemode: false},
        async execute(input, context) {
          const response = await fetch(${JSON.stringify(url)}, {method: "POST", headers: {"authorization": ${JSON.stringify(`Bearer ${token}`)}, "content-type": "application/json"}, signal: context.signal,
            body: JSON.stringify({action, input: {path: ".", ...input}, sessionID: context.sessionID, messageID: context.messageID, callID: context.id})});
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "bigbud coding action rejected");
          return {content: JSON.stringify(result)};
        }
      });
    });
  }};`;
}
