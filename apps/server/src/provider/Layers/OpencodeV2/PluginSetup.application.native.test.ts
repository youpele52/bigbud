import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { ThreadId } from "@bigbud/contracts";
import { expect, it, vi } from "vitest";
import { withV2AutomaticSetupApplication } from "./PluginSetup.application.fixture.ts";
import { v2ManagedPluginFilename } from "./PluginSetup.record.ts";

vi.mock("./Catalog.public.ts", async (original) => ({
  ...(await original<typeof import("./Catalog.public.ts")>()),
  makeV2PublicCatalogLoader: () => async () => ({ models: [], stale: false }),
}));
const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
const selection = {
  provider: "opencodeV2" as const,
  subProviderID: "bigbud-v2-fixture",
  model: "synthetic-model",
};
const start = (thread: string, cwd: string) => ({
  threadId: ThreadId.makeUnsafe(thread),
  cwd,
  runtimeMode: "full-access" as const,
  modelSelection: selection,
});

it.skipIf(!binary)(
  "production installs one global entry for automatically detected projects/worktrees, preserves every config byte, and verifies independent Locations without rewriting",
  async () => {
    await withV2AutomaticSetupApplication(
      binary!,
      async ({ app, native, registration, client, configRoot }) => {
        const adapter = registration.adapterService;
        const filename = path.join(configRoot, "plugins", v2ManagedPluginFilename(app.artifact));
        const globalBefore = await readFile(native.configFile);
        const secondary = path.join(configRoot, "opencode.jsonc");
        const legacy =
          '// existing comments and unknown configuration must survive\n{"plugins":[],"permissions":[{"action":"unrelated","resource":"*","effect":"deny"}],}\n';
        await writeFile(secondary, legacy, { mode: 0o600 });
        const worktree = path.join(path.dirname(native.workspace), "sibling-worktree");
        const git = promisify(execFile);
        await git("git", ["init", native.workspace]);
        // An orphan worktree needs no staging, commit or real repository modification.
        await git("git", [
          "-C",
          native.workspace,
          "worktree",
          "add",
          "--orphan",
          "-b",
          "owned-qualification",
          worktree,
        ]);
        const projectConfig = path.join(worktree, "opencode.jsonc");
        const projectBytes = '// project-level custom entry, never changed\n{"plugins":[],}\n';
        await writeFile(projectConfig, projectBytes, { mode: 0o600 });
        expect(
          (await Effect.runPromise(registration.providerService.refresh)).models.some(
            (model) => model.slug === selection.model,
          ),
        ).toBe(true);
        await expect(lstat(filename)).rejects.toThrow(); // model discovery never installs
        const first = await Effect.runPromise(
          adapter.startSession(start("auto-primary", native.workspace)),
        );
        const before = await lstat(filename);
        const firstId = (first.resumeCursor as { nativeSessionId: string }).nativeSessionId;
        expect((await client.session.get({ sessionID: firstId })).location.directory).toBe(
          native.workspace,
        );
        const other = await Effect.runPromise(
          adapter.startSession(start("auto-worktree", worktree)),
        );
        const otherId = (other.resumeCursor as { nativeSessionId: string }).nativeSessionId;
        expect((await client.session.get({ sessionID: otherId })).location.directory).toBe(
          worktree,
        );
        expect((await lstat(filename)).mtimeMs).toBe(before.mtimeMs);
        expect((await lstat(filename)).ino).toBe(before.ino);
        expect(await readFile(native.configFile)).toEqual(globalBefore);
        expect(await readFile(secondary, "utf8")).toBe(legacy);
        expect(await readFile(projectConfig, "utf8")).toBe(projectBytes);
        expect(native.state.requests).toHaveLength(0);
        await Effect.runPromise(adapter.stopSession(first.threadId));
        await Effect.runPromise(adapter.stopSession(other.threadId));
      },
    );
  },
  60000,
);

it.skipIf(!binary)(
  "old ack, other native config scope, malformed config, foreign filename and native removal fail without creation/admission or inventory loss",
  async () => {
    await withV2AutomaticSetupApplication(
      binary!,
      async ({ app, native, registration, settings, client, configRoot }) => {
        const adapter = registration.adapterService;
        const filename = path.join(configRoot, "plugins", v2ManagedPluginFilename(app.artifact));
        const models = (await Effect.runPromise(registration.providerService.refresh)).models;
        const original = await readFile(native.configFile);
        const unchanged = (await client.session.list()).data;
        async function rejected(name: string) {
          expect(
            (
              await Effect.runPromise(
                adapter.startSession(start(name, native.workspace)).pipe(Effect.result),
              )
            )._tag,
          ).toBe("Failure");
          expect(native.state.requests).toHaveLength(0);
          expect((await client.session.list()).data).toEqual(unchanged);
          expect((await Effect.runPromise(registration.providerService.refresh)).models).toEqual(
            models,
          );
          expect(await readFile(native.configFile)).toEqual(original);
        }
        await Effect.runPromise(
          settings.updateSettings({
            providers: { opencodeV2: { nativeServiceTrust: "host-user-v1" } },
          }),
        );
        await rejected("old-write-scope");
        await expect(lstat(filename)).rejects.toThrow();
        const wrongRoot = path.join(native.profile, "wrong-config");
        await mkdir(wrongRoot);
        await Effect.runPromise(
          settings.updateSettings({
            providers: {
              opencodeV2: {
                nativeServiceTrust: "managed-thread-tools-v2",
                nativePluginConfigRoot: wrongRoot,
              },
            },
          }),
        );
        await rejected("wrong-native-environment");
        await expect(lstat(path.join(wrongRoot, "plugins"))).rejects.toThrow();
        await Effect.runPromise(
          settings.updateSettings({
            providers: { opencodeV2: { nativePluginConfigRoot: configRoot } },
          }),
        );
        const malformed = path.join(configRoot, "opencode.jsonc");
        await writeFile(malformed, '{"plugins":[', { mode: 0o600 });
        await rejected("malformed-config");
        await expect(lstat(filename)).rejects.toThrow();
        await writeFile(malformed, '{"plugins":["-bigbud.thread.v1"]}', { mode: 0o600 });
        await rejected("explicit-native-removal");
        await expect(lstat(filename)).rejects.toThrow();
        await writeFile(malformed, '{"plugins":[]}', { mode: 0o600 });
        await mkdir(path.dirname(filename), { mode: 0o700 });
        await writeFile(filename, "// user-owned unrelated collision", { mode: 0o600 });
        await rejected("foreign-filename");
        expect(await readFile(filename, "utf8")).toBe("// user-owned unrelated collision");
      },
    );
  },
  60000,
);
