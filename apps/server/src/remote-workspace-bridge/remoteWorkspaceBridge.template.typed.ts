/**
 * Generated-source helpers shared by the MCP and Pi remote workspace bridges.
 * File tools call the typed `remoteTool` envelope of `remote_workspace_process`
 * (read_text, write_text, list_dir, search); the server runs them on the SSH
 * owner's typed workspace verbs or, on the legacy path, the fixed scripts the
 * bridges used to send. No raw process envelope is sent for these tools.
 *
 * `typedTool` must be called inside a bridge invocation; `invocationId`
 * supplies the stable per-step identity.
 *
 * @module remoteWorkspaceBridge.template.typed
 */
export const TYPED_REMOTE_TOOL_SOURCE: ReadonlyArray<string> = [
  "async function typedTool(remoteTool, invocationId, options = {}) {",
  "  const response = await callOrchestrationTool({",
  "    action: 'remote_workspace_process',",
  "    remoteInvocationId: invocationId,",
  "    remoteTool,",
  "    remoteTimeoutMs: options.timeoutMs ?? 30_000,",
  "  }, options.signal);",
  "  const tool = response.result?.tool;",
  "  if (!tool || tool.tool !== remoteTool.tool) throw new Error('The remote workspace tool returned no result.');",
  "  return tool;",
  "}",
  "",
  "function splitTextLines(content) {",
  "  const lines = content.split('\\n');",
  "  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();",
  "  return lines;",
  "}",
  "",
  "async function typedReadText(path, invocationId, options) {",
  "  return (await typedTool({ tool: 'read_text', path }, invocationId, options)).content;",
  "}",
  "",
  "async function typedWriteText(path, content, invocationId, options) {",
  "  await typedTool({ tool: 'write_text', path, content }, invocationId, options);",
  "}",
  "",
  "async function typedList(path, limit, invocationId, options) {",
  "  const result = await typedTool({ tool: 'list_dir', path }, invocationId, options);",
  "  const prefix = path.endsWith('/') ? path.slice(0, -1) : path;",
  "  return result.entries.map((entry) => `${prefix}/${entry.name}`).sort().slice(0, limit);",
  "}",
  "",
  "async function typedGlob(pattern, path, limit, invocationId, options) {",
  "  const result = await typedTool({ tool: 'glob', pattern, path, limit }, invocationId, options);",
  "  return result.paths;",
  "}",
  "",
  "async function typedSearch(pattern, path, limit, invocationId, options) {",
  "  const result = await typedTool({ tool: 'search', pattern, path, limit }, invocationId, options);",
  "  return result.matches.map((match) => `${match.path}:${match.line}:${match.text}`);",
  "}",
];
