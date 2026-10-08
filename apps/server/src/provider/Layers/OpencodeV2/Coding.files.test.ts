import { mkdtemp, mkdir, writeFile, readFile, symlink, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { V2CodingFiles, resolveV2FilePython } from "./Coding.files.ts";
import { V2CodingReceipts } from "./Coding.receipts.ts";

it("actual descriptor broker writes/reads/edits/checks while symlink races and protected plugin paths cannot mutate runtime storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2-coding-files-"));
  const profile = path.join(root, "profile"),
    workspace = path.join(root, "workspace");
  await mkdir(profile, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  try {
    const files = await V2CodingFiles.open(workspace, profile, await resolveV2FilePython(profile));
    await files.run({
      action: "write",
      path: "main.py",
      content: "value = 1\n",
      expectedSha256: null,
    });
    const current = await files.run({ action: "read", path: "main.py" });
    expect(current.content).toBe("value = 1\n");
    await files.run({
      action: "edit",
      path: "main.py",
      content: "value = 2\n",
      expectedSha256: current.sha256!,
    });
    expect((await files.run({ action: "check", path: "main.py" })).content).toContain(
      "no code was executed",
    );
    await expect(
      files.run({
        action: "write",
        path: "main.py",
        content: "wrong",
        expectedSha256: current.sha256!,
      }),
    ).rejects.toThrow("changed");
    await writeFile(path.join(profile, "secret"), "protected");
    await symlink(profile, path.join(workspace, "escape"));
    for (const action of ["read", "write", "edit"] as const)
      await expect(
        files.run({ action, path: "escape/secret", content: "wrong", expectedSha256: null }),
      ).rejects.toThrow();
    await mkdir(path.join(workspace, "nested"));
    const before = async () => {
      await rename(path.join(workspace, "nested"), path.join(workspace, "moved"));
      await symlink(profile, path.join(workspace, "nested"));
      return () => {};
    };
    await expect(
      files.run(
        { action: "write", path: "nested/plugin.mjs", content: "wrong", expectedSha256: null },
        before,
      ),
    ).rejects.toThrow();
    await expect(readFile(path.join(profile, "plugin.mjs"))).rejects.toThrow();
    await expect(
      files.run({
        action: "write",
        path: ".opencode/plugins/test.mjs",
        content: "wrong",
        expectedSha256: null,
      }),
    ).rejects.toThrow("configuration");
    await expect(
      files.run({
        action: "write",
        path: "../profile/secret",
        content: "wrong",
        expectedSha256: null,
      }),
    ).rejects.toThrow();
    expect(await readFile(path.join(profile, "secret"), "utf8")).toBe("protected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("root replacement is rejected and durable action intents never license uncertain writes or changed replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2-coding-receipts-"));
  const profile = path.join(root, "profile"),
    workspace = path.join(root, "workspace");
  await mkdir(profile, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  try {
    const files = await V2CodingFiles.open(workspace, profile, await resolveV2FilePython(profile));
    await rename(workspace, `${workspace}-old`);
    await mkdir(workspace);
    await expect(
      files.run({ action: "write", path: "main.py", content: "wrong", expectedSha256: null }),
    ).rejects.toThrow("root changed");
    const receipts = await V2CodingReceipts.open(profile);
    let calls = 0;
    await expect(
      receipts.run("uncertain", "same", async () => {
        calls++;
        throw new Error("unknown");
      }),
    ).rejects.toThrow("unknown");
    const restarted = await V2CodingReceipts.open(profile);
    await expect(
      restarted.run("uncertain", "same", async () => {
        calls++;
        return {};
      }),
    ).rejects.toThrow("unconfirmed");
    expect(calls).toBe(1);
    expect(await receipts.run("completed", "same", async () => ({ content: "result" }))).toEqual({
      content: "result",
    });
    expect(
      await restarted.run("completed", "same", async () => {
        throw new Error("must not run");
      }),
    ).toEqual({ content: "result" });
    await expect(restarted.run("completed", "changed", async () => ({}))).rejects.toThrow(
      "changed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
