/** Frozen pre-execution owned template. Only byte-exact provenance permits an upgrade; never execute this template. */
export function renderV2LegacyCodingPlugin(url: string, token: string) {
  const fields = {
    path: { type: "string" },
    content: { type: "string" },
    oldText: { type: "string" },
    newText: { type: "string" },
  };
  return `// bigbud-coding-owned-v1 ${JSON.stringify({ url, token })}
export default {id: "bigbud.coding.v1", async setup(ctx) {
    await ctx.tool.transform(editor => {
      for (const action of ${JSON.stringify(["read", "list", "write", "edit", "skill", "check"])}) editor.add({
        name: "bigbud_" + action,
        description: "Approval-required bounded workspace " + action + ". Relative no-symlink paths only. write replaces a file; edit replaces one exact oldText occurrence. skill reads .agents/skills/<name>/SKILL.md. check validates Python syntax without execution. No arbitrary shell, plugin or metadata writes.",
        input: {type: "object", properties: ${JSON.stringify(fields)}, required: ["path"], additionalProperties: false},
        options: {permission: "bigbud_coding", codemode: false},
        async execute(input, context) {
          const response = await fetch(${JSON.stringify(url)}, {method: "POST", headers: {"authorization": ${JSON.stringify(`Bearer ${token}`)}, "content-type": "application/json"}, signal: context.signal,
            body: JSON.stringify({action, input, sessionID: context.sessionID, messageID: context.messageID, callID: context.id})});
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "bigbud coding action rejected");
          return {content: JSON.stringify(result)};
        }
      });
    });
  }};`;
}
