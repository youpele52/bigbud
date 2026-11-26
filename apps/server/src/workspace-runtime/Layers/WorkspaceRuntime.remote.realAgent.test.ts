import { createHash, randomUUID } from "node:crypto";
import { link, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LocalWorkspaceWatchAgent } from "../../remote-agent/localWorkspaceWatchAgent.ts";
import { remoteAgentRequestDigest } from "../../remote-agent/remoteAgentRequestDigest.ts";
import { makeRemoteWorkspaceRuntime } from "./WorkspaceRuntime.remote.ts";

/**
 * Real-agent acceptance for guarded editor saves (remote file editing plan, E1). Runs a freshly
 * built `bigbud-remote-agent` in ephemeral mode on a disposable temp workspace and drives the real
 * server save path, verifying the bytes on disk. Opt in with
 * BIGBUD_TEST_REMOTE_EDIT_AGENT_BIN=<absolute path to the built agent binary>.
 */
const agentBinary = process.env.BIGBUD_TEST_REMOTE_EDIT_AGENT_BIN;
const enabled = typeof agentBinary === "string" && isAbsolute(agentBinary);
const target = "ssh:host=fixture&transport=agent";
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!enabled)("guarded saves against a real remote agent", () => {
  let agent: LocalWorkspaceWatchAgent;
  let root: string;
  let runtime: ReturnType<typeof makeRemoteWorkspaceRuntime>;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "bigbud-remote-edit-")));
    agent = new LocalWorkspaceWatchAgent({ resolveBinary: () => agentBinary! });
    runtime = makeRemoteWorkspaceRuntime({ resolve: () => agent.getWorkspaceClient() });
  });

  afterAll(async () => {
    agent?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const read = (relativePath: string) =>
    Effect.runPromise(
      runtime.files.readFilePreview({ executionTargetId: target, cwd: root, relativePath }),
    );
  const save = (relativePath: string, contents: string, expectedSha256: string) =>
    Effect.runPromise(
      runtime.files.writeFile({
        executionTargetId: target,
        cwd: root,
        relativePath,
        contents,
        expectedSha256,
        operationId: `acceptance-${randomUUID()}`,
      }),
    );
  const failedSave = (relativePath: string, contents: string, expectedSha256: string) =>
    Effect.runPromise(
      Effect.flip(
        runtime.files.writeFile({
          executionTargetId: target,
          cwd: root,
          relativePath,
          contents,
          expectedSha256,
          operationId: `acceptance-${randomUUID()}`,
        }),
      ),
    );

  it("opens, saves and reopens a file with the exact bytes and mode on disk", async () => {
    const file = join(root, "notes.txt");
    await writeFile(file, "first line\n", { mode: 0o640 });
    const opened = await read("notes.txt");
    expect(opened.edit).toEqual({ mode: "guarded", maxBytes: 512 * 1024 });
    expect(opened.sha256).toBe(sha256("first line\n"));
    const saved = await save("notes.txt", "first line!\n", opened.sha256!);
    expect(saved.resultSha256).toBe(sha256("first line!\n"));
    expect(await readFile(file, "utf8")).toBe("first line!\n");
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    const reopened = await read("notes.txt");
    expect(reopened).toMatchObject({ contents: "first line!\n", sha256: saved.resultSha256 });
    expect((await readdir(root)).filter((name) => name.startsWith(".bigbud-write-"))).toEqual([]);
  });

  it("refuses a save over an external change and leaves the external bytes", async () => {
    const file = join(root, "external.txt");
    await writeFile(file, "original");
    const opened = await read("external.txt");
    await writeFile(file, "changed by someone else");
    const error = await failedSave("external.txt", "my draft", opened.sha256!);
    expect(error).toMatchObject({
      conflict: true,
      currentSha256: sha256("changed by someone else"),
    });
    expect(await readFile(file, "utf8")).toBe("changed by someone else");
  });

  it("never applies two saves made against the same version (unknown-outcome retry safety)", async () => {
    await writeFile(join(root, "race.txt"), "base");
    const base = (await read("race.txt")).sha256!;
    const first = await save("race.txt", "first attempt", base);
    // The editor's retry after an unknown outcome is a new guarded save against the same base.
    const retry = await failedSave("race.txt", "retry attempt", base);
    expect(retry).toMatchObject({ conflict: true, currentSha256: first.resultSha256 });
    expect(await readFile(join(root, "race.txt"), "utf8")).toBe("first attempt");
  });

  it("edits a hard-linked file in place so every name keeps the same contents", async () => {
    const file = join(root, "linked.txt");
    await writeFile(file, "shared");
    await link(file, join(root, "linked-other.txt"));
    const inode = (await stat(file)).ino;
    await save("linked.txt", "shared, edited", (await read("linked.txt")).sha256!);
    expect(await readFile(join(root, "linked-other.txt"), "utf8")).toBe("shared, edited");
    expect((await stat(file)).ino).toBe(inode);
  });

  it("keeps a byte order mark and CRLF line endings", async () => {
    const file = join(root, "windows.txt");
    await writeFile(file, "﻿one\r\ntwo\r\n");
    const opened = await read("windows.txt");
    expect(opened.contents.startsWith("﻿")).toBe(true);
    await save("windows.txt", `${opened.contents}three\r\n`, opened.sha256!);
    const bytes = await readFile(file);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toBe("﻿one\r\ntwo\r\nthree\r\n");
  });

  it("does not create a missing file or its parents on a guarded save", async () => {
    const error = await failedSave("missing/dir/file.txt", "draft", sha256("anything"));
    expect(error).toMatchObject({ conflict: true });
    await expect(stat(join(root, "missing"))).rejects.toThrow();
  });

  it("answers a write receipt for a lost response with the hash on disk", async () => {
    await writeFile(join(root, "receipt.txt"), "before");
    const input = {
      executionTargetId: target,
      cwd: root,
      relativePath: "receipt.txt",
      contents: "after",
      expectedSha256: (await read("receipt.txt")).sha256!,
      operationId: `acceptance-${randomUUID()}`,
    };
    await Effect.runPromise(runtime.files.writeFile(input));
    const client = await agent.getWorkspaceClient();
    const requestDigest = remoteAgentRequestDigest(input);
    expect(
      await client.queryWriteReceipt({ operationId: input.operationId, requestDigest }),
    ).toEqual({
      applied: true,
      resultSha256: sha256("after"),
    });
    expect(
      await client.queryWriteReceipt({ operationId: `never-${randomUUID()}`, requestDigest }),
    ).toEqual({ applied: false });
  });
});
