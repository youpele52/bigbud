import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readDevProviderServices } from "./sshOwnerDevRuntime.providerServices.ts";

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

describe("dev SSH owner provider service bindings", () => {
  it("reads the configured absolute v1 and v2 executables", async () => {
    const profile = await profileWith({
      opencode: { binaryPath: "/opt/opencode/bin/opencode" },
      opencodeV2: { binaryPath: "/opt/opencode-v2/bin/opencode" },
    });
    await expect(readDevProviderServices(profile, "linux")).resolves.toEqual({
      opencodeService: { binaryPath: "/opt/opencode/bin/opencode" },
      opencodeV2Service: { binaryPath: "/opt/opencode-v2/bin/opencode" },
    });
  });

  it("types a missing v2 binding and never admits a relative one", async () => {
    const missing = await profileWith({});
    await expect(readDevProviderServices(missing, "linux")).resolves.toEqual({
      opencodeV2Refusal: "no-binding",
    });
    const relative = await profileWith({ opencodeV2: { binaryPath: "opencode" } });
    await expect(readDevProviderServices(relative, "linux")).resolves.toEqual({
      opencodeV2Refusal: "non-absolute-path",
    });
  });

  it("binds nothing on a platform without the owner lane", async () => {
    const profile = await profileWith({ opencodeV2: { binaryPath: "/opt/opencode-v2" } });
    await expect(readDevProviderServices(profile, "darwin")).resolves.toEqual({});
    await expect(readDevProviderServices(undefined, "linux")).resolves.toEqual({});
  });

  it("refuses padded, NUL-bearing or non-normalized paths under the shared rule", async () => {
    for (const binaryPath of [" /opt/opencode", "/opt/opencode\0", "/opt/../opencode", "/opt//x"]) {
      const profile = await profileWith({ opencodeV2: { binaryPath } });
      await expect(readDevProviderServices(profile, "linux")).resolves.toEqual({
        opencodeV2Refusal: "non-absolute-path",
      });
    }
  });

  it("types corrupt or unreadable settings distinctly from a missing binding", async () => {
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

  it("treats a missing settings file as no binding", async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "bigbud-provider-services-"));
    roots.push(profile);
    await expect(readDevProviderServices(profile, "linux")).resolves.toEqual({
      opencodeV2Refusal: "no-binding",
    });
  });
});
