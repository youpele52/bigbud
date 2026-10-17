import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { readV2SharedRegistration } from "./SharedService.registration.ts";
import { makeOwnedClient } from "./Client.ts";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";

const variant = vi.hoisted(() => ({ upgrade: false }));
vi.mock("./Orchestration.plugin.ts", async (original) => {
  const renderer = await original<typeof import("./Orchestration.plugin.ts")>();
  return {
    ...renderer,
    renderV2ThreadPlugin: () =>
      renderer.renderV2ThreadPlugin() +
      (variant.upgrade ? "\n// Disposable next immutable artifact qualification.\n" : ""),
  };
});

const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;

/** Disposable contract probe only: no production installer, actual native-user file, prompt or CLI reload. */
it.skipIf(!binary)(
  "qualifies global scope/watch/deny/managed upgrade and reproduces the manual/autoload alias collision to avoid",
  async () => {
    const app = await makeV2ThreadPluginFixture();
    const native = await sharedServiceNativeFixture(binary!);
    try {
      const endpoint = (await readV2SharedRegistration(native.file)).endpoint;
      const client = makeOwnedClient({ endpoint: endpoint.url, password: endpoint.auth!.password });
      const globalRoot = path.dirname(native.configFile);
      const original = await readFile(native.configFile);
      const another = path.join(path.dirname(native.workspace), "another-worktree");
      await mkdir(another);
      const firstSources = await client.config.get(
        { location: { directory: native.workspace } },
        { signal: AbortSignal.timeout(5000) },
      );
      const secondSources = await client.config.get(
        { location: { directory: another } },
        { signal: AbortSignal.timeout(5000) },
      );
      expect(
        firstSources.some((entry) => entry.type === "directory" && entry.path === globalRoot),
      ).toBe(true);
      expect(
        secondSources.some((entry) => entry.type === "directory" && entry.path === globalRoot),
      ).toBe(true);
      expect(firstSources.find((entry) => entry.type === "directory")?.path).toBe(globalRoot);
      expect(secondSources.find((entry) => entry.type === "directory")?.path).toBe(globalRoot);
      const info = (directory: string) =>
        client.rpc.call(
          { rpcID: "bigbud.thread.v1", method: "info", location: { directory }, input: {} },
          { signal: AbortSignal.timeout(5000) },
        );
      await expect(info(native.workspace)).rejects.toThrow();
      const plugins = path.join(globalRoot, "plugins");
      await mkdir(plugins, { mode: 0o700 });
      const shim = path.join(plugins, "bigbud-thread-tools-managed.js");
      await writeFile(shim, `export {default} from ${JSON.stringify(app.artifact.entryUri)};\n`, {
        mode: 0o600,
        flag: "wx",
      });
      for (const directory of [native.workspace, another]) {
        await expect
          .poll(
            () =>
              info(directory).then(
                (result) => result.output,
                () => undefined,
              ),
            { timeout: 15000 },
          )
          .toMatchObject({
            issuer: app.artifact.issuer,
            artifactDigest: app.artifact.artifactDigest,
          });
        const inventory = await client.plugin.list({ location: { directory } });
        expect(inventory.data.find((plugin) => plugin.id === "bigbud.thread.v1")?.source).toEqual({
          type: "local",
          path: shim,
        });
      }
      expect(await readFile(native.configFile)).toEqual(original);
      const projectRoot = path.join(native.workspace, ".opencode");
      await mkdir(projectRoot, { mode: 0o700 });
      const projectConfig = path.join(projectRoot, "opencode.jsonc");
      await writeFile(
        projectConfig,
        '// Native user removal policy must win.\n{"plugins":["-bigbud.thread.v1"]}\n',
        { mode: 0o600 },
      );
      await expect
        .poll(
          () =>
            info(native.workspace).then(
              () => false,
              () => true,
            ),
          { timeout: 15000 },
        )
        .toBe(true);
      expect((await info(another)).output).toMatchObject({ issuer: app.artifact.issuer });
      await writeFile(projectConfig, JSON.stringify({ plugins: [app.artifact.pluginUri] }), {
        mode: 0o600,
      });
      await expect
        .poll(
          () =>
            info(native.workspace).then(
              (result) => result.output,
              () => undefined,
            ),
          { timeout: 15000 },
        )
        .toMatchObject({
          issuer: app.artifact.issuer,
          artifactDigest: app.artifact.artifactDigest,
        });
      // Raw autoload plus manual configuration is NOT a safe installation route: even an identical
      // directory URI can produce duplicate native records. Reuse manual setup without a shim.
      await expect
        .poll(
          () =>
            client.plugin
              .list(
                { location: { directory: native.workspace } },
                { signal: AbortSignal.timeout(5000) },
              )
              .then((result) =>
                result.data.some(
                  (plugin) =>
                    plugin.id === "bigbud.thread.v1" &&
                    plugin.source.type === "local" &&
                    plugin.source.path.startsWith(fileURLToPath(app.artifact.pluginUri)),
                ),
              ),
          { timeout: 15000 },
        )
        .toBe(true);
      const aliases = (
        await client.plugin.list({ location: { directory: native.workspace } })
      ).data.filter((plugin) => plugin.id === "bigbud.thread.v1");
      console.info(
        "Disposable manual/autoload alias records:",
        aliases.map((plugin) => ({ id: plugin.id, source: plugin.source })),
      );
      expect(aliases.length).toBeGreaterThanOrEqual(1);
      await writeFile(projectConfig, '{"plugins":[]}\n', { mode: 0o600 });
      await expect
        .poll(
          () =>
            client.plugin
              .list({ location: { directory: native.workspace } })
              .then(
                (result) => result.data.filter((plugin) => plugin.id === "bigbud.thread.v1").length,
              ),
          { timeout: 15000 },
        )
        .toBe(1);
      variant.upgrade = true;
      const upgraded = await exportV2ThreadArtifact(app.root);
      expect(upgraded.issuer).toBe(app.artifact.issuer);
      expect(upgraded.artifactDigest).not.toBe(app.artifact.artifactDigest);
      await writeFile(shim, `export {default} from ${JSON.stringify(upgraded.entryUri)};\n`, {
        mode: 0o600,
      });
      for (const directory of [native.workspace, another])
        await expect
          .poll(
            () =>
              info(directory).then(
                (result) => result.output,
                () => undefined,
              ),
            { timeout: 15000 },
          )
          .toMatchObject({ issuer: upgraded.issuer, artifactDigest: upgraded.artifactDigest });
      expect(native.state.requests).toHaveLength(0);
      expect(await readFile(native.configFile)).toEqual(original);
    } finally {
      variant.upgrade = false;
      await native.close();
      await app.close();
    }
  },
  60000,
);

it.skipIf(!binary)(
  "global removal policy does not get silently re-enabled by filesystem autoload",
  async () => {
    const app = await makeV2ThreadPluginFixture();
    const native = await sharedServiceNativeFixture(binary!, async (file) => {
      const config = JSON.parse(await readFile(file, "utf8"));
      config.plugins = ["-bigbud.thread.v1"];
      await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    });
    try {
      const endpoint = (await readV2SharedRegistration(native.file)).endpoint;
      const client = makeOwnedClient({ endpoint: endpoint.url, password: endpoint.auth!.password });
      const plugins = path.join(path.dirname(native.configFile), "plugins");
      await mkdir(plugins, { mode: 0o700 });
      await writeFile(
        path.join(plugins, "bigbud-thread-tools-managed.js"),
        `export {default} from ${JSON.stringify(app.artifact.entryUri)};\n`,
        { mode: 0o600, flag: "wx" },
      );
      await writeFile(
        path.join(plugins, "watch-settlement.js"),
        'export default {id:"bigbud.autoload.qualifier",async setup(){}};\n',
        { mode: 0o600, flag: "wx" },
      );
      await expect
        .poll(
          () =>
            client.plugin
              .list({ location: { directory: native.workspace } })
              .then((result) =>
                result.data.some((plugin) => plugin.id === "bigbud.autoload.qualifier"),
              ),
          { timeout: 15000 },
        )
        .toBe(true);
      await expect
        .poll(async () => {
          const sources = await client.config.get({ location: { directory: native.workspace } });
          return sources.some(
            (entry) =>
              entry.type === "document" && entry.info.plugins?.includes("-bigbud.thread.v1"),
          );
        })
        .toBe(true);
      await expect(
        client.rpc.call({
          rpcID: "bigbud.thread.v1",
          method: "info",
          location: { directory: native.workspace },
          input: {},
        }),
      ).rejects.toThrow();
      expect(native.state.requests).toHaveLength(0);
    } finally {
      await native.close();
      await app.close();
    }
  },
  30000,
);
