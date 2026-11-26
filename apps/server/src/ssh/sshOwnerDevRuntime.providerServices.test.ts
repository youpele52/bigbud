import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readDevProviderServices,
  readProductionOpencodeV2Service,
} from "./sshOwnerDevRuntime.providerServices.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function profileWith(providers: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bigbud-provider-services-"));
  roots.push(root);
  await mkdir(path.join(root, "dev"), { recursive: true });
  await writeFile(path.join(root, "dev", "settings.json"), JSON.stringify({ providers }), "utf8");
  return root;
}

describe("SSH owner OpenCode v2 remote binding", () => {
  it("keeps the local binaryPath local and discovers remotely by default", async () => {
    const profile = await profileWith({
      opencode: { binaryPath: "/opt/opencode/bin/opencode" },
      opencodeV2: { binaryPath: "/Applications/OpenCode/bin/opencode" },
    });
    await expect(readDevProviderServices(profile, "linux")).resolves.toEqual({
      opencodeV2Service: {},
    });
    const empty = await profileWith({ opencodeV2: { remoteBinaryPath: "" } });
    await expect(readDevProviderServices(empty, "linux")).resolves.toEqual({
      opencodeV2Service: {},
    });
  });

  it("uses an explicit remoteBinaryPath override when set", async () => {
    const profile = await profileWith({
      opencodeV2: { binaryPath: "/local/opencode", remoteBinaryPath: "/opt/opencode-v2/opencode" },
    });
    await expect(readDevProviderServices(profile, "linux")).resolves.toEqual({
      opencodeV2Service: { binaryPath: "/opt/opencode-v2/opencode" },
    });
  });

  it("binds nothing on a platform without the dev owner lane", async () => {
    const profile = await profileWith({ opencodeV2: { remoteBinaryPath: "/opt/opencode-v2" } });
    await expect(readDevProviderServices(profile, "darwin")).resolves.toEqual({});
    await expect(readDevProviderServices(undefined, "linux")).resolves.toEqual({});
  });

  it("refuses a relative, padded, NUL-bearing or non-normalized override", async () => {
    for (const remoteBinaryPath of [
      "opencode",
      " /opt/opencode",
      "/opt/opencode\0",
      "/opt/../opencode",
      "/opt//x",
    ]) {
      const profile = await profileWith({ opencodeV2: { remoteBinaryPath } });
      await expect(readDevProviderServices(profile, "linux")).resolves.toEqual({
        opencodeV2Refusal: "non-absolute-path",
      });
    }
  });

  it("types corrupt or unreadable settings distinctly", async () => {
    const corrupt = await profileWith({});
    await writeFile(path.join(corrupt, "dev", "settings.json"), "{not json", "utf8");
    await expect(readDevProviderServices(corrupt, "linux")).resolves.toEqual({
      opencodeV2Refusal: "settings-unreadable",
    });
    const directory = await profileWith({});
    await rm(path.join(directory, "dev", "settings.json"));
    await mkdir(path.join(directory, "dev", "settings.json"));
    await expect(readDevProviderServices(directory, "linux")).resolves.toEqual({
      opencodeV2Refusal: "settings-unreadable",
    });
  });

  it("discovers when no settings file exists", async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "bigbud-provider-services-"));
    roots.push(profile);
    await expect(readDevProviderServices(profile, "linux")).resolves.toEqual({
      opencodeV2Service: {},
    });
  });

  it("production reads the same rule from the server settings file on macOS and Linux", async () => {
    const profile = await profileWith({ opencodeV2: { binaryPath: "/local/opencode" } });
    const settings = path.join(profile, "dev", "settings.json");
    for (const platform of ["darwin", "linux"] as const)
      await expect(readProductionOpencodeV2Service(settings, platform)).resolves.toEqual({
        opencodeV2Service: {},
      });
    await expect(readProductionOpencodeV2Service(settings, "win32")).resolves.toEqual({});
  });

  it("production keeps an invalid remoteBinaryPath as its typed refusal", async () => {
    const profile = await profileWith({ opencodeV2: { remoteBinaryPath: "opencode" } });
    const settings = path.join(profile, "dev", "settings.json");
    await expect(readProductionOpencodeV2Service(settings, "linux")).resolves.toEqual({
      opencodeV2Refusal: "non-absolute-path",
    });
  });
});
