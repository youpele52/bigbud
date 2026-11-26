import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { it } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect } from "vitest";
import * as Effect from "effect/Effect";

import { resolveSshOwnerArtifact } from "./sshOwnerProductionArtifact.ts";

type Platform = "darwin" | "linux" | "win32";
type Arch = "arm64" | "x64";

function nativeHeader(platform: Platform, arch: Arch): Buffer {
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

describe("production SSH owner artifact targets (U4)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), "ssh-owner-artifact-targets-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const resolvePackaged = (platform: Platform, arch: Arch) =>
    resolveSshOwnerArtifact({
      config: { mode: "desktop", devUrl: undefined },
      entryUrl: pathToFileURL(join(root, "server/dist/bin.mjs")).href,
      environment: { BIGBUD_DESKTOP_PACKAGED: "1" },
      platform,
      arch,
    });

  it.effect.each([
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
  ] as const)("resolves the packaged desktop owner on %s/%s", ([platform, arch]) =>
    Effect.gen(function* () {
      const owner = join(
        root,
        "server/ssh-owner/bin",
        platform === "win32" ? "bigbud-ssh-owner.exe" : "bigbud-ssh-owner",
      );
      yield* Effect.promise(async () => {
        await mkdir(dirname(owner), { recursive: true });
        await writeFile(owner, nativeHeader(platform, arch));
        await chmod(owner, 0o755);
      });
      expect(yield* resolvePackaged(platform, arch)).toMatchObject({
        kind: "resolved",
        artifact: { profile: "desktop-packaged", path: owner, target: { platform, arch } },
      });
    }),
  );

  it.effect("refuses Windows arm64 for packaged, standalone and remote profiles", () =>
    Effect.gen(function* () {
      for (const [config, environment] of [
        [{ mode: "desktop", devUrl: undefined }, { BIGBUD_DESKTOP_PACKAGED: "1" }],
        [{ mode: "web", devUrl: undefined }, {}],
        [{ mode: "remote", devUrl: undefined }, {}],
      ] as const) {
        const resolution = yield* resolveSshOwnerArtifact({
          config,
          entryUrl: pathToFileURL(join(root, "server/dist/bin.mjs")).href,
          environment,
          platform: "win32",
          arch: "arm64",
        });
        expect(resolution).toMatchObject({
          kind: "unavailable",
          error: { code: "sshOwnerUnavailable", reason: "owner-incompatible" },
        });
      }
    }),
  );
});
