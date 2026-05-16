import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { createOpencodeRemoteWorkspaceBridge } from "./OpencodeRemoteWorkspaceBridge.ts";

function expectTranspiles(relativePath: string, source: string): void {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  expect(errors).toEqual([]);
}

describe("OpencodeRemoteWorkspaceBridge", () => {
  it("creates transpileable override tools in a synthetic cwd", async () => {
    const bridge = await createOpencodeRemoteWorkspaceBridge({
      location: "remote",
      executionTargetId: "ssh:host=devbox&user=root&port=22",
      cwd: "/srv/project",
    });

    const generatedFiles = [
      ".bigbud/opencode-remote-runtime.ts",
      ".opencode/tools/read.ts",
      ".opencode/tools/write.ts",
      ".opencode/tools/edit.ts",
      ".opencode/tools/bash.ts",
      ".opencode/tools/grep.ts",
      ".opencode/tools/glob.ts",
      ".opencode/tools/list.ts",
      ".opencode/tools/apply_patch.ts",
    ] as const;

    for (const relativePath of generatedFiles) {
      const source = await fs.readFile(path.join(bridge.cwd, relativePath), "utf8");
      expect(source.length).toBeGreaterThan(0);
      expectTranspiles(relativePath, source);
    }

    const runtimeSource = await fs.readFile(
      path.join(bridge.cwd, ".bigbud/opencode-remote-runtime.ts"),
      "utf8",
    );
    expect(runtimeSource).toContain("/srv/project");
    expect(runtimeSource).toContain("root@devbox");
    expect(runtimeSource).toContain("readRemoteFileContents");

    const readToolSource = await fs.readFile(
      path.join(bridge.cwd, ".opencode/tools/read.ts"),
      "utf8",
    );
    expect(readToolSource).toContain("export default tool({");

    const editToolSource = await fs.readFile(
      path.join(bridge.cwd, ".opencode/tools/edit.ts"),
      "utf8",
    );
    expect(editToolSource).toContain("readRemoteFileContents");

    await bridge.cleanup();
    await expect(fs.access(bridge.cwd)).rejects.toThrow();
  });
});
