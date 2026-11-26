import { expect, it, vi } from "vitest";

import type {
  TypedSshToolCapability,
  TypedSshToolOwner,
} from "../tool-transport/toolTransport.ssh.owner.ts";
import { applyFilePatch, parseUnifiedPatch } from "./http.threadTools.remoteWorkspacePatch.ts";
import {
  decodeRemoteWorkspaceTool,
  rootRelative,
  runLegacyRemoteWorkspaceTool,
  runOwnedRemoteWorkspaceTool,
} from "./http.threadTools.remoteWorkspaceTool.ts";

const root = "/srv/work";

function capability(files: Record<string, string>) {
  const owner = {
    readProofWorkspaceFile: vi.fn(async (input: { relativePath: string }) => {
      const data = files[input.relativePath];
      if (data === undefined) throw new Error("missing");
      const bytes = new TextEncoder().encode(data);
      return { data: bytes, sizeBytes: bytes.length, truncated: false };
    }),
    writeProofWorkspaceFile: vi.fn(
      async (input: { relativePath: string; contents: Uint8Array }) => {
        files[input.relativePath] = new TextDecoder().decode(input.contents);
      },
    ),
    listProofWorkspaceDirectory: vi.fn(async () => ({
      entries: [{ name: "a", directory: false }],
      truncated: false,
    })),
    searchProofWorkspaceContents: vi.fn(async () => ({
      matches: [
        { path: "src/x.ts", line: 1, lineText: "needle" },
        { path: "lib/y.ts", line: 2, lineText: "needle" },
      ],
      truncated: false,
    })),
    createProofWorkspaceDirectory: vi.fn(
      async (_input: { relativePath: string }) => "created" as const,
    ),
    deleteProofWorkspaceEntry: vi.fn(
      async (_input: { relativePath: string }) => "deleted" as const,
    ),
  };
  const cap: TypedSshToolCapability = {
    targetId: "ssh:host=a",
    workspaceRoot: root,
    withOwner: async (_id, use) => use(owner as unknown as TypedSshToolOwner),
  };
  return { cap, owner, files };
}

it("resolves paths inside the root only", () => {
  expect(rootRelative(root, "a/b.txt")).toBe("a/b.txt");
  expect(rootRelative(root, "/srv/work/a")).toBe("a");
  expect(rootRelative(root, ".")).toBe("");
  for (const path of ["../x", "/etc/passwd", "/srv/workshop/x", "a/../../x"])
    expect(() => rootRelative(root, path)).toThrow(/outside the workspace/);
  expect(() => decodeRemoteWorkspaceTool({ tool: "exec" })).toThrow();
});

it("runs read, write (with parents), list and literal search on the owner's typed verbs", async () => {
  const { cap, owner, files } = capability({ "f.txt": "one\n" });
  await expect(
    runOwnedRemoteWorkspaceTool(cap, { tool: "read_text", path: "f.txt" }),
  ).resolves.toEqual({ tool: "read_text", content: "one\n" });
  await runOwnedRemoteWorkspaceTool(cap, { tool: "write_text", path: "d/e/g.txt", content: "x" });
  expect(
    owner.createProofWorkspaceDirectory.mock.calls.map(([input]) => input.relativePath),
  ).toEqual(["d", "d/e"]);
  expect(files["d/e/g.txt"]).toBe("x");
  const found = await runOwnedRemoteWorkspaceTool(cap, {
    tool: "search",
    pattern: "needle",
    path: "src",
    limit: 10,
  });
  expect(found).toMatchObject({ matches: [{ path: "src/x.ts", line: 1, text: "needle" }] });
  await expect(
    runOwnedRemoteWorkspaceTool(cap, { tool: "search", pattern: "a.*b", path: ".", limit: 5 }),
  ).rejects.toThrow(/Regular-expression grep/);
});

it("applies a unified patch through typed reads and writes, all-or-nothing", async () => {
  const { cap, files, owner } = capability({ "a.txt": "one\ntwo\nthree\n", "gone.txt": "x\n" });
  const patch = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "--- /dev/null",
    "+++ b/new/n.txt",
    "@@ -0,0 +1 @@",
    "+fresh",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-x",
    "",
  ].join("\n");
  await expect(runOwnedRemoteWorkspaceTool(cap, { tool: "apply_patch", patch })).resolves.toEqual({
    tool: "apply_patch",
    files: ["a.txt", "new/n.txt", "gone.txt"],
  });
  expect(files["a.txt"]).toBe("one\nTWO\nthree\n");
  expect(files["new/n.txt"]).toBe("fresh\n");
  expect(owner.deleteProofWorkspaceEntry).toHaveBeenCalledWith(
    expect.objectContaining({ relativePath: "gone.txt", expectedDirectory: false }),
  );
  const writes = owner.writeProofWorkspaceFile.mock.calls.length;
  const bad = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-missing\n+x\n";
  await expect(
    runOwnedRemoteWorkspaceTool(cap, { tool: "apply_patch", patch: bad }),
  ).rejects.toThrow(/does not apply/);
  expect(owner.writeProofWorkspaceFile.mock.calls.length).toBe(writes);
});

it("keeps trailing-newline state and hunk offsets", () => {
  const [file] = parseUnifiedPatch(
    "--- a/x\n+++ b/x\n@@ -5,1 +5,1 @@\n-c\n+C\n\\ No newline at end of file\n",
  );
  expect(applyFilePatch("a\nb\nc", file!)).toBe("a\nb\nC");
});

it("uses the fixed legacy scripts with stdin only for writes and patches", async () => {
  const run = vi.fn(async () => ({ stdout: "d src\nf a.txt\n", stderr: "", code: 0 }));
  await expect(runLegacyRemoteWorkspaceTool(run, { tool: "list_dir", path: "." })).resolves.toEqual(
    {
      tool: "list_dir",
      entries: [
        { name: "src", directory: true },
        { name: "a.txt", directory: false },
      ],
      truncated: false,
    },
  );
  await runLegacyRemoteWorkspaceTool(run, { tool: "write_text", path: "a", content: "c" });
  expect(run.mock.calls.at(-1)).toEqual([
    "sh",
    ["-lc", expect.stringContaining('cat > "$target"'), "bigbud-write", "a"],
    { stdin: "c" },
  ]);
});

it("matches typed glob patterns like ripgrep -g over the owner index", async () => {
  const { matchGlob } = await import("./http.threadTools.remoteWorkspaceGlob.ts");
  const entries = [
    { path: "src/a.ts", directory: false },
    { path: "src/deep/b.ts", directory: false },
    { path: "src/deep/c.js", directory: false },
    { path: "src/deep", directory: true },
    { path: "lib/d.ts", directory: false },
  ];
  expect(matchGlob(entries, "src", "*.ts", 10)).toEqual(["a.ts", "deep/b.ts"]);
  expect(matchGlob(entries, "", "src/**/*.{ts,js}", 10)).toEqual([
    "src/a.ts",
    "src/deep/b.ts",
    "src/deep/c.js",
  ]);
  expect(matchGlob(entries, "src", "deep/?.ts", 10)).toEqual(["deep/b.ts"]);
  const { cap } = capability({});
  const index = vi.fn(async () => ({ entries, truncated: false }));
  await expect(
    runOwnedRemoteWorkspaceTool(
      cap,
      { tool: "glob", pattern: "*.ts", path: "lib", limit: 5 },
      undefined,
      index,
    ),
  ).resolves.toEqual({ tool: "glob", paths: ["d.ts"], truncated: false });
  await expect(
    runOwnedRemoteWorkspaceTool(
      cap,
      { tool: "glob", pattern: "*.ts", path: "../x", limit: 5 },
      undefined,
      index,
    ),
  ).rejects.toThrow(/outside the workspace/);
});
