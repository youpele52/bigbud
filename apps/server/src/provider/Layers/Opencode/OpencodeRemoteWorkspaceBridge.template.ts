import type { RemoteWorkspaceBridgeConfig } from "../../../remote-workspace-bridge/remoteWorkspaceBridge.ts";

import { renderToolSource } from "./OpencodeRemoteWorkspaceBridge.template.helpers.ts";
import { renderRuntimeSource } from "./OpencodeRemoteWorkspaceBridge.template.runtime.ts";

export function renderOpencodeRemoteWorkspaceBridgeFiles(
  input: RemoteWorkspaceBridgeConfig,
): Record<string, string> {
  return {
    ".bigbud/opencode-remote-runtime.ts": renderRuntimeSource(input),
    ".opencode/tools/read.ts": renderToolSource({
      description:
        "Read a file from the remote workspace over SSH. Supports relative and absolute paths and optional line pagination.",
      argsSource: [
        '    path: tool.schema.string().describe("Remote file path to read"),',
        '    offset: tool.schema.number().int().positive().optional().describe("1-indexed line offset"),',
        '    limit: tool.schema.number().int().positive().optional().describe("Maximum number of lines to read"),',
      ].join("\n"),
      executeBody: ["return runtime.readRemoteFile(args.path, args.offset, args.limit);"],
    }),
    ".opencode/tools/write.ts": renderToolSource({
      description: "Write or overwrite a file in the remote workspace over SSH.",
      argsSource: [
        '    path: tool.schema.string().describe("Remote file path to write"),',
        '    content: tool.schema.string().describe("Full file contents"),',
      ].join("\n"),
      executeBody: ["return runtime.writeRemoteFile(args.path, args.content);"],
    }),
    ".opencode/tools/edit.ts": renderToolSource({
      description:
        "Apply one or more exact-string edits to a file in the remote workspace over SSH.",
      argsSource: [
        '    path: tool.schema.string().describe("Remote file path to edit"),',
        '    oldText: tool.schema.string().optional().describe("Existing text to replace when performing a single edit"),',
        '    newText: tool.schema.string().optional().describe("Replacement text for a single edit"),',
        "    edits: tool.schema",
        "      .array(",
        "        tool.schema.object({",
        '          oldText: tool.schema.string().describe("Existing text to replace"),',
        '          newText: tool.schema.string().describe("Replacement text"),',
        "        }),",
        "      )",
        '      .optional().describe("Batch edits to apply in order"),',
      ].join("\n"),
      executeBody: [
        "const edits = args.edits ?? (args.oldText !== undefined && args.newText !== undefined",
        "  ? [{ oldText: args.oldText, newText: args.newText }]",
        "  : []);",
        "if (edits.length === 0) {",
        "  throw new Error('Provide either edits[] or both oldText and newText.');",
        "}",
        "const current = await runtime.readRemoteFileContents(args.path);",
        "const next = runtime.applyEditsToContent(current, edits, args.path);",
        "return runtime.writeRemoteFile(args.path, next);",
      ],
    }),
    ".opencode/tools/bash.ts": renderToolSource({
      description: "Run a shell command in the remote workspace over SSH and return stdout/stderr.",
      argsSource: [
        '    command: tool.schema.string().describe("Shell command to execute remotely"),',
      ].join("\n"),
      executeBody: ["return runtime.runRemoteBash(args.command);"],
    }),
    ".opencode/tools/grep.ts": renderToolSource({
      description: "Search the remote workspace using ripgrep over SSH.",
      argsSource: [
        '    pattern: tool.schema.string().describe("Text or regex pattern to search for"),',
        '    path: tool.schema.string().optional().describe("Optional remote directory or file to search within"),',
      ].join("\n"),
      executeBody: ["return runtime.runRemoteGrep(args.pattern, args.path);"],
    }),
    ".opencode/tools/glob.ts": renderToolSource({
      description: "List remote workspace files matching a glob pattern over SSH.",
      argsSource: [
        '    pattern: tool.schema.string().describe("Glob pattern, for example **/*.ts"),',
        '    path: tool.schema.string().optional().describe("Optional remote directory to search from"),',
      ].join("\n"),
      executeBody: ["return runtime.runRemoteGlob(args.pattern, args.path);"],
    }),
    ".opencode/tools/list.ts": renderToolSource({
      description: "List a remote directory over SSH.",
      argsSource: [
        '    path: tool.schema.string().optional().describe("Remote directory to list"),',
      ].join("\n"),
      executeBody: ["return runtime.runRemoteList(args.path);"],
    }),
    ".opencode/tools/apply_patch.ts": renderToolSource({
      description: "Apply a unified diff patch to the remote workspace over SSH.",
      argsSource: ['    patch: tool.schema.string().describe("Unified diff patch contents"),'].join(
        "\n",
      ),
      executeBody: ["return runtime.applyRemotePatch(args.patch);"],
    }),
  };
}
