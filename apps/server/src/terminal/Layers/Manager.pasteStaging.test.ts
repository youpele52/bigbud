import { createHash } from "node:crypto";
import { mkdtempSync, promises as fs, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import type { TerminalSessionSnapshot } from "@bigbud/contracts";
import { TerminalSessionLookupError } from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalPasteStageInput } from "@bigbud/contracts/workspace/terminal.paste.ts";
import { afterEach, describe, expect, it } from "vitest";

import { LocalPasteStore } from "./Manager.pasteStaging.local.ts";
import { makeTerminalPasteStaging } from "./Manager.pasteStaging.ts";
import type { RemotePasteAgent } from "./Manager.pasteStaging.target.ts";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(
  overrides: {
    target?: string;
    generation?: string;
    maxFileBytes?: number;
    remote?: (target: string) => RemotePasteAgent;
  } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "bigbud paste test "));
  roots.push(root);
  const session = {
    status: "running" as TerminalSessionSnapshot["status"],
    generation: overrides.generation ?? "gen-1",
    target: overrides.target ?? "local",
    open: true,
  };
  const remoteTargets: string[] = [];
  const staging = makeTerminalPasteStaging({
    local: new LocalPasteStore(path.join(root, "terminal-paste")),
    snapshot: (input) =>
      session.open
        ? Effect.succeed({
            threadId: input.threadId,
            terminalId: input.terminalId ?? "default",
            executionTargetId: session.target,
            runtimeGeneration: session.generation,
            status: session.status,
          } as unknown as TerminalSessionSnapshot)
        : Effect.fail(
            new TerminalSessionLookupError({ threadId: input.threadId, terminalId: "x" }),
          ),
    maxFileBytes: () => overrides.maxFileBytes ?? 20 * 1024 * 1024,
    remote: overrides.remote
      ? (target) =>
          Effect.sync(() => {
            remoteTargets.push(target);
            return overrides.remote!(target);
          })
      : undefined,
  });
  const run = (input: TerminalPasteStageInput) => Effect.runPromise(staging.stage(input));
  const failCode = (input: TerminalPasteStageInput) =>
    Effect.runPromise(Effect.flip(staging.stage(input)).pipe(Effect.map((error) => error.code)));
  const upload = async (
    bytes: Buffer,
    extra: Partial<{ fileName: string; generation: string }> = {},
  ) => {
    const begun = await run({
      op: "begin",
      threadId: "thread-1",
      terminalId: "default",
      fileName: extra.fileName ?? "Screenshot 2026.png",
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      ...(extra.generation ? { expectedGeneration: extra.generation } : {}),
    });
    if (begun.op !== "begin") throw new Error("expected begin");
    await run({ op: "chunk", uploadId: begun.uploadId, offset: 0, data: bytes.toString("base64") });
    return begun;
  };
  return { root, session, staging, run, failCode, upload, remoteTargets };
}

describe("terminal paste staging (local)", () => {
  it("stages an image as a private file with an absolute, space-free path", async () => {
    const test = harness();
    const begun = await test.upload(PNG);
    expect(begun.host).toBe("local");
    const committed = await test.run({
      op: "commit",
      uploadId: begun.uploadId,
      sha256: createHash("sha256").update(PNG).digest("hex"),
    });
    if (committed.op !== "commit") throw new Error("expected commit");
    expect(path.isAbsolute(committed.path)).toBe(true);
    expect(committed.path).toBe(await fs.realpath(committed.path));
    expect(path.basename(committed.path)).toMatch(/^paste-[0-9a-f]{24}\.png$/);
    expect(committed.path.startsWith(await fs.realpath(test.root))).toBe(true);
    expect(await fs.readFile(committed.path)).toEqual(PNG);
    if (process.platform !== "win32") {
      expect(statSync(committed.path).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(committed.path)).mode & 0o777).toBe(0o700);
    }
    expect(committed.clipboard).toBe("skipped");
  });

  it("names non-images by a sanitized extension and never trusts the claimed type", async () => {
    const test = harness();
    const pdf = Buffer.from("%PDF-1.7 hello");
    const begun = await test.upload(pdf, { fileName: "../../etc/report final.PDF" });
    const committed = await test.run({ op: "commit", uploadId: begun.uploadId });
    if (committed.op !== "commit") throw new Error("expected commit");
    expect(path.basename(committed.path)).toMatch(/^paste-[0-9a-f]{24}\.pdf$/);
    const evil = await test.upload(pdf, { fileName: "x.p n/g" });
    const other = await test.run({ op: "commit", uploadId: evil.uploadId });
    if (other.op !== "commit") throw new Error("expected commit");
    expect(path.basename(other.path)).toMatch(/\.bin$/);
  });

  it("rejects oversized files before any upload", async () => {
    const test = harness({ maxFileBytes: 10 });
    const code = await test.failCode({
      op: "begin",
      threadId: "thread-1",
      terminalId: "default",
      fileName: "big.png",
      mimeType: "image/png",
      byteLength: 11,
    });
    expect(code).toBe("tooLarge");
  });

  it("rejects a stale generation at begin and a restart before commit", async () => {
    const test = harness();
    expect(
      await test.failCode({
        op: "begin",
        threadId: "thread-1",
        terminalId: "default",
        expectedGeneration: "gen-0",
        fileName: "a.png",
        mimeType: "image/png",
        byteLength: PNG.byteLength,
      }),
    ).toBe("terminalChanged");
    const begun = await test.upload(PNG, { generation: "gen-1" });
    test.session.generation = "gen-2";
    expect(await test.failCode({ op: "commit", uploadId: begun.uploadId })).toBe("terminalChanged");
    const staged = await fs.readdir(path.join(test.root, "terminal-paste"));
    expect(staged).toEqual([]);
  });

  it("rejects corrupted, out-of-order and unknown uploads", async () => {
    const test = harness();
    const begun = await test.upload(PNG);
    expect(
      await test.failCode({ op: "commit", uploadId: begun.uploadId, sha256: "0".repeat(64) }),
    ).toBe("integrity");
    expect(await test.failCode({ op: "commit", uploadId: begun.uploadId })).toBe("invalidUpload");
    const second = await test.upload(PNG.subarray(0, 8));
    expect(
      await test.failCode({ op: "chunk", uploadId: second.uploadId, offset: 3, data: "AAAA" }),
    ).toBe("invalidUpload");
  });

  it("deletes staged files when the terminal is released or its session disappears", async () => {
    const test = harness();
    const first = await test.upload(PNG);
    const one = await test.run({ op: "commit", uploadId: first.uploadId });
    if (one.op !== "commit") throw new Error("expected commit");
    await Effect.runPromise(test.staging.release("thread-1", "default"));
    await expect(fs.stat(one.path)).rejects.toThrow();
    const second = await test.upload(PNG);
    const two = await test.run({ op: "commit", uploadId: second.uploadId });
    if (two.op !== "commit") throw new Error("expected commit");
    await Effect.runPromise(test.staging.reconcile);
    await fs.stat(two.path);
    test.session.generation = "gen-restarted";
    await Effect.runPromise(test.staging.reconcile);
    await expect(fs.stat(two.path)).rejects.toThrow();
  });

  it("refuses WSL terminals and SSH terminals without a remote agent", async () => {
    for (const [target, expected] of [
      ["wsl:Ubuntu", "unsupportedTarget"],
      ["ssh:vps.example", "remoteAgentRequired"],
    ] as const) {
      const test = harness({ target });
      const code = await test.failCode({
        op: "begin",
        threadId: "thread-1",
        terminalId: "default",
        fileName: "a.png",
        mimeType: "image/png",
        byteLength: 4,
      });
      expect(code).toBe(expected);
    }
  });
});
