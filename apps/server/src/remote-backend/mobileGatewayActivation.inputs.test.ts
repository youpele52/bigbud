import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterEach, expect, it, vi } from "vitest";
import { ServerConfig } from "../startup/config.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import {
  makeRemoteMobileNativeInputsLayer,
  RemoteMobileNativeInputs,
  RemoteMobileNativeInputsReport,
} from "./mobileGatewayActivation.inputs.ts";
import { readMobileNativeInputs } from "./mobileGatewayActivation.inputs.read.ts";
import {
  inputsAuthorityId,
  mobileInputsFixture,
  signedMobileArtifact,
} from "./mobileGatewayActivation.inputs.fixture.ts";

type Fixture = Awaited<ReturnType<typeof mobileInputsFixture>>;
let fixture: Fixture | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture?.close();
  fixture = undefined;
});
const setup = async () => (fixture = await mobileInputsFixture());
const read = (f: Fixture, authorityId = inputsAuthorityId) =>
  readMobileNativeInputs({ homeDir: f.home, authorityId });

it("absent directory or file means off, without creating anything", async () => {
  const f = await setup();
  expect(await read(f, "e".repeat(32))).toEqual({ kind: "absent" });
  expect(await read(f)).toEqual({ kind: "absent" });
  expect(await fs.readdir(f.root)).toEqual([]);
});

it("loads a valid owner-private file into frozen inputs", async () => {
  const f = await setup();
  await f.write();
  const report = await read(f);
  if (report.kind !== "loaded") throw Error(`Expected loaded, got ${JSON.stringify(report)}`);
  expect(report.value.artifacts).toMatchObject({
    stageId: "fixture-stage",
    gatewayPath: f.gatewayPath,
    assetsPath: f.assetsPath,
  });
  expect(Object.keys(report.value.trustedKeys)).toEqual(["fixture"]);
  expect(Object.isFrozen(report.value.artifacts)).toBe(true);
});

it("refuses insecure modes, symlinks, oversize and foreign owners with a reason", async () => {
  const f = await setup();
  await f.write(f.file, 0o644);
  expect(await read(f)).toEqual({ kind: "invalid", reason: "unsafe-file" });

  await f.write();
  const real = join(f.home, "real-inputs");
  await fs.rename(f.path, real);
  await fs.symlink(real, f.path);
  expect(await read(f)).toEqual({ kind: "invalid", reason: "unsafe-file" });
  await fs.rm(f.path);

  await f.write(`${JSON.stringify(f.file)}${" ".repeat(256 * 1024)}`);
  expect(await read(f)).toEqual({ kind: "invalid", reason: "unsafe-file" });

  await f.write();
  vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
  expect((await read(f)).kind).toBe("invalid");
  vi.restoreAllMocks();

  await fs.chmod(f.root, 0o777);
  expect(await read(f)).toEqual({ kind: "invalid", reason: "unsafe-directory" });
});

it("decodes strictly and verifies signatures against exactly the pinned keys", async () => {
  const f = await setup();
  const tampered = { ...f.file.gateway, sizeBytes: f.file.gateway.sizeBytes + 1 };
  const other = generateKeyPairSync("ed25519");
  const otherPem = other.publicKey.export({ type: "spki", format: "pem" }).toString();
  const foreignGateway = signedMobileArtifact(
    "mobile-gateway",
    Buffer.from("fixture gateway executable bytes"),
    other.privateKey,
  );
  const cases: Array<[unknown, string]> = [
    [{ ...f.file, extra: true }, "malformed"],
    [{ ...f.file, schemaVersion: 2 }, "malformed"],
    [{ ...f.file, stageId: "has space" }, "malformed"],
    [{ ...f.file, gatewayPath: "relative/gateway" }, "malformed"],
    [{ ...f.file, assetsPath: f.file.gatewayPath }, "malformed"],
    [{ ...f.file, trustedKeys: {} }, "untrusted-keys"],
    [{ ...f.file, trustedKeys: { fixture: "not a key" } }, "untrusted-keys"],
    [{ ...f.file, gateway: tampered }, "unsigned-artifacts"],
    [{ ...f.file, gateway: f.file.assets, assets: f.file.gateway }, "unsigned-artifacts"],
    [{ ...f.file, trustedKeys: { other: f.file.trustedKeys.fixture } }, "unsigned-artifacts"],
    [{ ...f.file, trustedKeys: { fixture: otherPem } }, "unsigned-artifacts"],
    [{ ...f.file, gateway: foreignGateway }, "unsigned-artifacts"],
  ];
  for (const [content, reason] of cases) {
    await f.write(content);
    expect(await read(f), reason).toEqual({ kind: "invalid", reason });
  }
  await f.write("{not json");
  expect(await read(f)).toEqual({ kind: "invalid", reason: "malformed" });
});

it("requires owned, single-link, non-symlink artifact files with the signed size", async () => {
  const f = await setup();
  await f.write();
  await fs.writeFile(f.gatewayPath, "different length");
  expect(await read(f)).toEqual({ kind: "invalid", reason: "unsafe-artifact-file" });
  const bytes = Buffer.from("fixture gateway executable bytes");
  await fs.rm(f.gatewayPath);
  const target = join(f.home, "gateway-target");
  await fs.writeFile(target, bytes, { mode: 0o600 });
  await fs.symlink(target, f.gatewayPath);
  expect(await read(f)).toEqual({ kind: "invalid", reason: "unsafe-artifact-file" });
  await fs.rm(f.gatewayPath);
  await fs.writeFile(f.gatewayPath, bytes, { mode: 0o666 });
  await fs.chmod(f.gatewayPath, 0o666);
  expect(await read(f)).toEqual({ kind: "invalid", reason: "unsafe-artifact-file" });
  await fs.chmod(f.gatewayPath, 0o600);
  expect((await read(f)).kind).toBe("loaded");
});

const services = (mode: "remote" | "desktop") =>
  Layer.mergeAll(
    Layer.succeed(ServerConfig, { mode } as never),
    Layer.succeed(RemoteBackendIdentityService, {
      authority: { authorityId: inputsAuthorityId },
    } as never),
  );
const build = (layer: Layer.Layer<RemoteMobileNativeInputs | RemoteMobileNativeInputsReport>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return {
        inputs: yield* RemoteMobileNativeInputs,
        report: yield* RemoteMobileNativeInputsReport,
      };
    }).pipe(Effect.provide(layer)),
  );

it("layer performs no IO off Linux or outside remote mode, and loads on Linux remote", async () => {
  const f = await setup();
  await f.write();
  const homeDir = vi.fn(() => f.home);
  for (const [platform, mode] of [
    ["darwin", "remote"],
    ["linux", "desktop"],
  ] as const) {
    const off = await build(
      makeRemoteMobileNativeInputsLayer({ platform, homeDir }).pipe(Layer.provide(services(mode))),
    );
    expect(Option.isNone(off.inputs)).toBe(true);
    expect(off.report).toEqual({ kind: "unsupported" });
  }
  expect(homeDir).not.toHaveBeenCalled();
  const on = await build(
    makeRemoteMobileNativeInputsLayer({ platform: "linux", homeDir }).pipe(
      Layer.provide(services("remote")),
    ),
  );
  expect(Option.isSome(on.inputs)).toBe(true);
  expect(on.report.kind).toBe("loaded");
});
