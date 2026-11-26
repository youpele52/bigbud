import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { it } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect } from "vitest";
import * as Effect from "effect/Effect";

import { SSH_OWNER_PRODUCTION_ACTIVATION } from "@bigbud/shared/SshOwnerActivation";

import {
  configureSshOwner,
  readSshOwnerAdmission,
  readSshOwnerProductionConfiguration,
  resetSshOwnerProductionStateForTest,
} from "./sshOwnerProductionComposition.ts";
import { resolveSshOwnerArtifact, resolveSshOwnerProfile } from "./sshOwnerProductionArtifact.ts";
import { assertLegacySshLaunchAllowed, isSshOwnerSelected } from "./sshOwnerSelection.ts";

function nativeHeader(platform: "darwin" | "linux" | "win32", arch: "arm64" | "x64"): Buffer {
  const bytes = Buffer.alloc(512);
  const arm64 = arch === "arm64";
  if (platform === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(arm64 ? 0x0100000c : 0x01000007, 4);
    bytes.writeUInt32LE(2, 12);
  } else if (platform === "linux") {
    bytes.writeUInt32BE(0x7f454c46, 0);
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(3, 16);
    bytes.writeUInt16LE(arm64 ? 0xb7 : 0x3e, 18);
  } else {
    const peOffset = 128;
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(peOffset, 0x3c);
    bytes.writeUInt32LE(0x00004550, peOffset);
    bytes.writeUInt16LE(arm64 ? 0xaa64 : 0x8664, peOffset + 4);
    bytes.writeUInt16LE(240, peOffset + 20);
    bytes.writeUInt16LE(0x0002, peOffset + 22);
    bytes.writeUInt16LE(0x020b, peOffset + 24);
  }
  return bytes;
}

async function stage(path: string, bytes: Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  await chmod(path, 0o755);
}

describe("production SSH owner composition", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), "ssh-owner-production-"));
    resetSshOwnerProductionStateForTest();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves D, V, N and R profiles without dev selectors", () => {
    expect(resolveSshOwnerProfile({ mode: "remote", devUrl: undefined })).toBe("remote-backend");
    expect(
      resolveSshOwnerProfile(
        { mode: "desktop", devUrl: undefined },
        { BIGBUD_DESKTOP_PACKAGED: "1" },
      ),
    ).toBe("desktop-packaged");
    expect(resolveSshOwnerProfile({ mode: "desktop", devUrl: undefined }, {})).toBe("desktop-dev");
    expect(resolveSshOwnerProfile({ mode: "web", devUrl: new URL("http://127.0.0.1:5173") })).toBe(
      "desktop-dev",
    );
    expect(resolveSshOwnerProfile({ mode: "web", devUrl: undefined })).toBe("standalone");
  });

  it.effect("resolves the packaged desktop artifact from the sidecar path", () =>
    Effect.gen(function* () {
      const owner = join(root, "server/ssh-owner/bin/bigbud-ssh-owner");
      yield* Effect.promise(() => stage(owner, nativeHeader("darwin", "arm64")));
      const resolution = yield* resolveSshOwnerArtifact({
        config: { mode: "desktop", devUrl: undefined },
        entryUrl: pathToFileURL(join(root, "server/dist/bin.mjs")).href,
        // A locator that matches the staged path is accepted; any other path is ignored.
        environment: { BIGBUD_DESKTOP_PACKAGED: "1", BIGBUD_SSH_OWNER_BIN: owner },
        platform: "darwin",
        arch: "arm64",
      });
      expect(resolution).toMatchObject({
        kind: "resolved",
        artifact: { profile: "desktop-packaged", path: owner, evidence: "header" },
      });
    }),
  );

  it.effect("never lets the environment substitute a packaged owner artifact", () =>
    Effect.gen(function* () {
      const owner = join(root, "server/ssh-owner/bin/bigbud-ssh-owner");
      yield* Effect.promise(() => stage(owner, nativeHeader("darwin", "arm64")));
      const resolution = yield* resolveSshOwnerArtifact({
        config: { mode: "desktop", devUrl: undefined },
        entryUrl: pathToFileURL(join(root, "server/dist/bin.mjs")).href,
        environment: {
          BIGBUD_DESKTOP_PACKAGED: "1",
          BIGBUD_SSH_OWNER_BIN: join(root, "elsewhere/bigbud-ssh-owner"),
        },
        platform: "darwin",
        arch: "arm64",
      });
      expect(resolution).toMatchObject({ kind: "resolved", artifact: { path: owner } });
    }),
  );

  it.effect("resolves the dev artifact from an absolute owner path", () =>
    Effect.gen(function* () {
      const owner = join(root, "target/debug/bigbud-ssh-owner");
      yield* Effect.promise(() => stage(owner, nativeHeader("darwin", "arm64")));
      const resolution = yield* resolveSshOwnerArtifact({
        config: { mode: "web", devUrl: new URL("http://localhost:5173") },
        entryUrl: pathToFileURL(join(root, "apps/server/src/bin.ts")).href,
        environment: { BIGBUD_SSH_OWNER_BIN: owner },
        platform: "darwin",
        arch: "arm64",
      });
      expect(resolution).toMatchObject({ kind: "resolved", artifact: { profile: "desktop-dev" } });
    }),
  );

  it.effect("resolves N and R only against a trusted manifest digest", () =>
    Effect.gen(function* () {
      const target = "darwin-arm64";
      const filename = "bigbud-ssh-owner";
      const owner = join(root, `dist/ssh-owner/${target}/${filename}`);
      const bytes = nativeHeader("darwin", "arm64");
      yield* Effect.promise(() => stage(owner, bytes));
      const manifest = {
        platform: "darwin",
        arch: "arm64",
        relativePath: `ssh-owner/${target}/${filename}`,
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      for (const mode of ["web", "remote"] as const) {
        const resolution = yield* resolveSshOwnerArtifact({
          config: { mode, devUrl: undefined },
          entryUrl: pathToFileURL(join(root, "dist/bin.mjs")).href,
          environment: {},
          platform: "darwin",
          arch: "arm64",
          trustedManifestEntry: manifest,
        });
        expect(resolution).toMatchObject({ kind: "resolved", artifact: { evidence: "digest" } });
      }
    }),
  );

  it.effect("fails closed with a typed sshOwnerUnavailable", () =>
    Effect.gen(function* () {
      const missing = yield* resolveSshOwnerArtifact({
        config: { mode: "desktop", devUrl: undefined },
        entryUrl: pathToFileURL(join(root, "server/dist/bin.mjs")).href,
        environment: { BIGBUD_DESKTOP_PACKAGED: "1" },
        platform: "darwin",
        arch: "arm64",
      });
      expect(missing).toMatchObject({
        kind: "unavailable",
        error: { code: "sshOwnerUnavailable", reason: "owner-missing" },
      });

      const unverified = yield* resolveSshOwnerArtifact({
        config: { mode: "web", devUrl: undefined },
        entryUrl: pathToFileURL(join(root, "dist/bin.mjs")).href,
        environment: {},
        platform: "darwin",
        arch: "arm64",
      });
      expect(unverified).toMatchObject({
        kind: "unavailable",
        error: { reason: "owner-unverified" },
      });
    }),
  );

  it.effect("keeps today's behaviour while the activation constant is off", () =>
    Effect.gen(function* () {
      const configuration = yield* configureSshOwner(
        { mode: "desktop", devUrl: undefined, stateDir: root },
        pathToFileURL(join(root, "server/dist/bin.mjs")).href,
      );
      expect(SSH_OWNER_PRODUCTION_ACTIVATION).toBe(false);
      expect(configuration).toEqual({ kind: "inactive" });
      expect(readSshOwnerAdmission()).toEqual({ kind: "inactive" });
    }),
  );

  it.effect("keeps local features working when the activated owner is missing", () =>
    Effect.gen(function* () {
      const configuration = yield* configureSshOwner(
        { mode: "desktop", devUrl: undefined, stateDir: root },
        pathToFileURL(join(root, "server/dist/bin.mjs")).href,
        {
          activation: true,
          environment: { BIGBUD_DESKTOP_PACKAGED: "1" },
          platform: "darwin",
          arch: "arm64",
        },
      );
      expect(configuration).toMatchObject({
        kind: "unavailable",
        error: { code: "sshOwnerUnavailable", reason: "owner-missing" },
      });
      expect(readSshOwnerAdmission()).toMatchObject({
        kind: "closed",
        step: "configuration",
        error: { code: "sshOwnerUnavailable" },
      });
      // A local feature is an ordinary effect; configuration never fails the server.
      const local = yield* Effect.succeed("local-work");
      expect(local).toBe("local-work");
    }),
  );

  it.effect("composes the owner and refuses legacy launches when activated", () =>
    Effect.gen(function* () {
      const owner = join(root, "server/ssh-owner/bin/bigbud-ssh-owner");
      yield* Effect.promise(() => stage(owner, nativeHeader("darwin", "arm64")));
      const configuration = yield* configureSshOwner(
        { mode: "desktop", devUrl: undefined, stateDir: root },
        pathToFileURL(join(root, "server/dist/bin.mjs")).href,
        {
          activation: true,
          environment: { BIGBUD_DESKTOP_PACKAGED: "1" },
          platform: "darwin",
          arch: "arm64",
        },
      );
      expect(configuration).toMatchObject({
        kind: "configured",
        artifact: { profile: "desktop-packaged" },
      });
      expect(readSshOwnerProductionConfiguration()).toEqual(configuration);
      expect(isSshOwnerSelected(true)).toBe(true);
      expect(isSshOwnerSelected(false)).toBe(false);
      expect(() => assertLegacySshLaunchAllowed(true)).toThrow(/selected SSH owner/);
    }),
  );
});
