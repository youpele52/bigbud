import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeLocalSupervisorServiceConfig } from "./localSupervisorService.config.ts";
import { readLocalSupervisorServiceConfig } from "./localSupervisorService.config.read.ts";
import { serviceConfigFixture } from "./localSupervisorService.test.helpers.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});
async function fixture() {
  const homeDir = await fs.realpath(await fs.mkdtemp("/tmp/br-"));
  homes.push(homeDir);
  const authorityId = serviceConfigFixture.authority;
  const configPath = join(homeDir, ".bigbud/backend-services", authorityId, "config-v1");
  await fs.mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const config = { ...serviceConfigFixture, home: homeDir };
  const raw = encodeLocalSupervisorServiceConfig(config);
  await fs.writeFile(configPath, raw, { mode: 0o600 });
  return { homeDir, authorityId, configPath, config, raw };
}

describe("shared private account service config reader", () => {
  it("reads strict config at the same stable path before or after loaded identity exists", async () => {
    const f = await fixture();
    expect(await readLocalSupervisorServiceConfig(f)).toEqual({ config: f.config, raw: f.raw });
    expect(
      await readLocalSupervisorServiceConfig({ homeDir: f.homeDir, configPath: f.configPath }),
    ).toEqual({ config: f.config, raw: f.raw });
  });
  it("refuses another selected authority or nonstable path", async () => {
    const f = await fixture();
    await expect(
      readLocalSupervisorServiceConfig({ ...f, authorityId: "b".repeat(32) }),
    ).rejects.toThrow("stable account authority path");
    await expect(
      readLocalSupervisorServiceConfig({
        ...f,
        configPath: join(dirname(f.configPath), "other-config"),
      }),
    ).rejects.toThrow("stable account authority path");
  });
  it.each(["home", "authority"] as const)("refuses a config for another %s", async (field) => {
    const f = await fixture();
    await fs.writeFile(
      f.configPath,
      encodeLocalSupervisorServiceConfig({
        ...f.config,
        [field]: field === "home" ? "/other/account" : "b".repeat(32),
      }),
    );
    await expect(readLocalSupervisorServiceConfig(f)).rejects.toThrow(
      "another account or authority",
    );
  });
  it("never follows a linked private config", async () => {
    const f = await fixture();
    const original = `${f.configPath}.retained`;
    await fs.rename(f.configPath, original);
    await fs.symlink(original, f.configPath);
    await expect(readLocalSupervisorServiceConfig(f)).rejects.toThrow("must not contain links");
  });
  it("refuses unsafe account directories and nonprivate config permissions", async () => {
    const f = await fixture();
    await fs.chmod(dirname(f.configPath), 0o755);
    await expect(readLocalSupervisorServiceConfig(f)).rejects.toThrow("safely permissioned");
    await fs.chmod(dirname(f.configPath), 0o700);
    await fs.chmod(f.configPath, 0o644);
    await expect(readLocalSupervisorServiceConfig(f)).rejects.toThrow(
      /private owned .*regular file/,
    );
  });
});
