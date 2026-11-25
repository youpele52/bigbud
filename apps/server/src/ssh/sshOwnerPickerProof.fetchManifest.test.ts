import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { expect, it } from "vitest";

import { GRAPH_STAGE_SCRIPT } from "../remote-backend/deployment.fetch.ts";
import { makeDeploymentSshRunner } from "../remote-backend/deployment.ssh.ts";
import { deploymentForPickerProof } from "./sshOwnerPickerProof.deployment.ts";
import {
  approve,
  live,
  signal,
  withFixture,
  withOwner,
} from "./sshOwnerPickerProof.scopedNative.fixture.ts";

function packet(payload: string) {
  return `${(4 + Buffer.byteLength(payload)).toString(16).padStart(4, "0")}${payload}`;
}

function readPackets(stream: Readable) {
  const input = stream.iterator({ destroyOnReturn: false });
  let pending = Buffer.alloc(0);
  async function take(size: number) {
    while (pending.length < size) {
      const chunk = await input.next();
      if (chunk.done) throw new Error("Git stream ended before its section was complete");
      pending = Buffer.concat([pending, chunk.value]);
      if (pending.length > 65_536) throw new Error("Oversized Git proof section");
    }
    const result = pending.subarray(0, size);
    pending = pending.subarray(size);
    return result;
  }
  return {
    async section() {
      const lines: string[] = [];
      for (;;) {
        const header = (await take(4)).toString("ascii");
        if (header === "0000") return lines;
        if (!/^[0-9a-f]{4}$/.test(header)) throw new Error("Malformed Git packet header");
        const size = Number.parseInt(header, 16);
        if (size < 5 || size > 4096 || lines.length >= 32)
          throw new Error("Invalid Git proof section");
        lines.push((await take(size - 4)).toString("utf8"));
      }
    },
    async done() {
      if (pending.length) throw new Error("Unexpected trailing Git bytes");
      expect((await input.next()).done).toBe(true);
    },
  };
}

it.skipIf(!live)(
  "carries two live upload-pack negotiations without any writable Git service",
  () =>
    withFixture(async (fixture) => {
      const repositoryPath = path.join(fixture.root, "upload.git");
      for (const dir of ["objects/info", "objects/pack", "refs/heads", "refs/tags"])
        await mkdir(path.join(repositoryPath, dir), { recursive: true, mode: 0o700 });
      const config = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n";
      await writeFile(path.join(repositoryPath, "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 });
      await writeFile(path.join(repositoryPath, "config"), config, { mode: 0o600 });
      await withOwner(
        fixture,
        { gitUploadFixture: { repositoryPath } },
        async (owner, executionTargetId) => {
          await approve(owner);
          await expect(
            owner.openGitAdvertisement(
              {
                executionTargetId,
                repositoryPath,
                sourceRef: "refs/heads/main",
                destinationRef: "refs/heads/main",
                sourceOid: "1".repeat(40),
              },
              signal(),
            ),
          ).rejects.toMatchObject({ code: "operationDenied" });
          const lease = await owner.openGitUpload({ executionTargetId, repositoryPath }, signal());
          const reader = readPackets(lease.pipes.stdout);
          const stderr = text(lease.pipes.stderr);
          await expect(reader.section()).resolves.toEqual(
            expect.arrayContaining(["version 2\n", expect.stringMatching(/^ls-refs=/)]),
          );
          for (let i = 0; i < 2; i++) {
            lease.pipes.stdin.write(
              `${packet("command=ls-refs\n")}0001${packet("symrefs\n")}${packet("unborn\n")}0000`,
            );
            await expect(reader.section()).resolves.toEqual([
              "unborn HEAD symref-target:refs/heads/main\n",
            ]);
          }
          lease.pipes.stdin.end("0000");
          await reader.done();
          await expect(stderr).resolves.toBe("");
          await expect(lease.exit).resolves.toEqual({ code: 0, signal: null });
          expect(await readdir(path.join(repositoryPath, "refs/heads"))).toEqual([]);
          expect(await readFile(path.join(repositoryPath, "config"), "utf8")).toBe(config);
        },
      );
    }),
  60_000,
);

it.skipIf(!live).each(["store", "stale"] as const)(
  "binds manifest put to the exact acknowledged stage and live generation (%s)",
  (mode) =>
    withFixture(async (fixture) => {
      const root = path.join(fixture.root, "deployment-graphs");
      await mkdir(root, { mode: 0o700 });
      const requestId = randomUUID();
      const body = '{"fixture":"opaque-manifest"}\n';
      const manifestSha256 = createHash("sha256").update(body).digest("hex");
      const archiveSha256 = "a".repeat(64);
      const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
      const installName = `0.1.0-${architecture}-unknown-linux-gnu-${archiveSha256.slice(0, 16)}`;
      const stage = path.join(root, `.staging-${requestId}`);
      await withOwner(
        fixture,
        { deploymentStageFixture: { root, requestId, manifestSha256, archiveSha256, installName } },
        async (owner, target) => {
          await approve(owner);
          const run = makeDeploymentSshRunner({
            kind: "owner",
            owner: deploymentForPickerProof(owner, { fixtureStage: true }),
          });
          const put = (text: string) =>
            run(
              target,
              {
                command: "/bin/sh",
                args: [
                  "-c",
                  GRAPH_STAGE_SCRIPT,
                  "sh",
                  "put",
                  requestId,
                  "manifest.json",
                  manifestSha256,
                ],
                stdin: { text },
                timeoutMs: 60_000,
              },
              signal(),
            );
          await expect(put(body)).rejects.toThrow("owner refused");
          await expect(
            run(
              target,
              {
                command: "/bin/sh",
                args: [
                  "-c",
                  GRAPH_STAGE_SCRIPT,
                  "sh",
                  "begin",
                  requestId,
                  installName,
                  archiveSha256,
                  manifestSha256,
                ],
                timeoutMs: 60_000,
              },
              signal(),
            ),
          ).resolves.toMatchObject({ code: 0 });
          if (mode === "stale") {
            await owner.connect();
            await expect(put(body)).rejects.toThrow("owner refused");
            expect(await readdir(stage)).toEqual([]);
            return;
          }
          await expect(put("not the approved digest")).rejects.toThrow("owner refused");
          expect(await readdir(stage)).toEqual([]);
          await expect(put(body)).resolves.toMatchObject({ code: 0, stdout: "manifest-stored\n" });
          await expect(put(body)).rejects.toThrow("owner refused");
          const file = path.join(stage, "manifest.json");
          expect(await readFile(file, "utf8")).toBe(body);
          expect((await stat(file)).mode & 0o777).toBe(0o600);
          expect(await readdir(root)).toEqual([`.staging-${requestId}`]);
        },
      );
    }),
  60_000,
);
