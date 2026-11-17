import * as fs from "node:fs/promises";
import { join } from "node:path";
import * as Option from "effect/Option";
import { afterEach, expect, it } from "vitest";
import { setMobileNativeInputs } from "./cli.mobile.inputs.ts";
import { readMobileNativeInputs } from "../remote-backend/mobileGatewayActivation.inputs.read.ts";
import {
  inputsAuthorityId,
  mobileInputsFixture,
} from "../remote-backend/mobileGatewayActivation.inputs.fixture.ts";
import { mobileRegistryReleaseId } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";

type Fixture = Awaited<ReturnType<typeof mobileInputsFixture>>;
let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});
async function sources(f: Fixture) {
  const write = async (name: string, value: unknown) => {
    const path = join(f.home, name);
    await fs.writeFile(path, JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  return {
    authorityId: inputsAuthorityId,
    trustedKeys: await write("keys.json", f.file.trustedKeys),
    gateway: await write("gateway.json", f.file.gateway),
    assets: await write("assets.json", f.file.assets),
    gatewayFile: f.gatewayPath,
    assetsFile: f.assetsPath,
    stageId: Option.none<string>(),
  };
}

it("writes a private inputs file the backend reader loads, and never replaces it", async () => {
  const f = (fixture = await mobileInputsFixture());
  const input = await sources(f);
  const result = await setMobileNativeInputs(input, f.home);
  expect(result.path).toBe(f.path);
  expect(result.stageId).toBe(mobileRegistryReleaseId(f.file.gateway, f.file.assets));
  expect((await fs.stat(f.path)).mode & 0o777).toBe(0o600);
  const report = await readMobileNativeInputs({ homeDir: f.home, authorityId: inputsAuthorityId });
  expect(report.kind === "loaded" && report.value.artifacts.stageId).toBe(result.stageId);
  await expect(setMobileNativeInputs(input, f.home)).rejects.toMatchObject({ code: "EEXIST" });
});

it("refuses wrong artifact bytes and non-private descriptor files before writing", async () => {
  const f = (fixture = await mobileInputsFixture());
  const input = await sources(f);
  await fs.writeFile(f.assetsPath, "fixture assets archive byteZ");
  await expect(setMobileNativeInputs(input, f.home)).rejects.toMatchObject({
    reason: "unsafe-artifact-file",
  });
  await fs.writeFile(f.assetsPath, "fixture assets archive bytes");
  await fs.chmod(input.gateway, 0o644);
  await expect(setMobileNativeInputs(input, f.home)).rejects.toThrow();
  await expect(fs.lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
});
