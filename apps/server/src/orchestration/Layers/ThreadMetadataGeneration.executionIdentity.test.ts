import { join } from "node:path";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import type { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerSettingsShape } from "../../ws/serverSettings.ts";
import type {
  MetadataCapturedContext,
  MetadataCapturedPath,
} from "./ThreadMetadataGeneration.context.ts";
import { makeMetadataExecutionIdentity } from "./ThreadMetadataGeneration.executionIdentity.ts";

const codex: ModelSelection = {
  provider: "codex",
  model: "gpt-5",
  options: { reasoningEffort: "high" },
};
const cursor: ModelSelection = { provider: "cursor", model: "auto" };
const claude: ModelSelection = { provider: "claudeAgent", model: "claude-sonnet-4-6" };
const context = {
  operation: "title",
  workspace: { executionTarget: "local" },
} as MetadataCapturedContext;

function fixture() {
  const initial = structuredClone(DEFAULT_SERVER_SETTINGS);
  const current = {
    ...initial,
    providers: {
      ...initial.providers,
      codex: {
        ...initial.providers.codex,
        homePath: "/configured-codex",
        binaryPath: "/same-codex",
      },
      cursor: { ...initial.providers.cursor, binaryPath: "/same-agent" },
      claudeAgent: { ...initial.providers.claudeAgent, binaryPath: "/same-claude" },
    },
  };
  const state = {
    auth: JSON.stringify({ tokens: { account_id: "account-private" } }),
    stdout: JSON.stringify({ userEmail: "person@private.example" }),
    code: 0,
    hang: false,
    crash: false,
  };
  const read = vi.fn((_path: string) => Effect.succeed(state.auth));
  const spawn = vi.fn((_command: Parameters<Parameters<typeof ChildProcessSpawner.make>[0]>[0]) =>
    Effect.suspend(() => {
      if (state.crash) return Effect.die(new Error("secret credential diagnostic"));
      if (state.hang) return Effect.never;
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(state.code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(state.stdout)),
          stderr: Stream.make(new TextEncoder().encode("secret provider stderr")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
  const spawner = ChildProcessSpawner.make(spawn);
  const settings = { getSettings: Effect.sync(() => current) } as unknown as ServerSettingsShape;
  const make = makeMetadataExecutionIdentity(settings).pipe(
    Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({ readFileString: read })),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  return {
    current,
    state,
    read,
    spawn,
    make,
    snapshot: () => ({ revision: 1, settings: current }),
  };
}

function required(path: MetadataCapturedPath | null): MetadataCapturedPath {
  expect(path).not.toBeNull();
  return path!;
}

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN)/.test(key)) vi.stubEnv(key, "");
  }
  vi.stubEnv("HOME", "/mock-home");
  vi.stubEnv("CODEX_HOME", "/env-codex");
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("qualified metadata execution identity", () => {
  it("qualifies Codex auth from configured home and persists only opaque identities", async () => {
    const f = fixture();
    const api = await Effect.runPromise(f.make);
    const path = required(await Effect.runPromise(api.capture(codex, "local")));
    expect(f.read).toHaveBeenCalledWith(join("/configured-codex", "auth.json"));
    expect(f.spawn).not.toHaveBeenCalled();
    expect(path.accountIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(path.transport).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(path)).not.toMatch(/account-private|configured-codex|same-codex/);
    expect(path.selection).toEqual(codex);
    expect(path.selection).not.toBe(codex);
  });

  it("resolves CODEX_HOME then HOME without reading real files", async () => {
    const f = fixture();
    f.current.providers.codex.homePath = "";
    const api = await Effect.runPromise(f.make);
    required(await Effect.runPromise(api.capture(codex, "local")));
    expect(f.read).toHaveBeenLastCalledWith(join("/env-codex", "auth.json"));
    vi.stubEnv("CODEX_HOME", "");
    required(await Effect.runPromise(api.capture(codex, "local")));
    expect(f.read).toHaveBeenLastCalledWith(join("/mock-home", ".codex", "auth.json"));
  });

  it("hashes API credentials without guessing an account or persisting a key", async () => {
    const f = fixture();
    f.state.auth = "{}";
    const api = await Effect.runPromise(f.make);
    expect(await Effect.runPromise(api.capture(codex, "local"))).toBeNull();
    vi.stubEnv("OPENAI_API_KEY", "sk-private-one");
    const first = required(await Effect.runPromise(api.capture(codex, "local")));
    expect(JSON.stringify(first)).not.toContain("sk-private");
    vi.stubEnv("OPENAI_API_KEY", "sk-private-two");
    const second = required(await Effect.runPromise(api.capture(codex, "local")));
    expect(first.accountIdentity).not.toBe(second.accountIdentity);
    f.state.auth = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "file-key" });
    const file = required(await Effect.runPromise(api.capture(codex, "local")));
    expect(file.accountIdentity).not.toBe(second.accountIdentity);
  });

  it("returns null for nonlocal targets, disabled providers and unqualified providers", async () => {
    const f = fixture();
    const api = await Effect.runPromise(f.make);
    expect(await Effect.runPromise(api.capture(codex, "remote:host"))).toBeNull();
    expect(
      await Effect.runPromise(api.capture({ provider: "opencode", model: "x" }, "local")),
    ).toBeNull();
    f.current.providers.codex.enabled = false;
    expect(await Effect.runPromise(api.capture(codex, "local"))).toBeNull();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("probes Cursor using the exact CLI and configured endpoint, not desktop credentials", async () => {
    const f = fixture();
    f.current.providers.cursor.apiEndpoint = "https://private.endpoint";
    const api = await Effect.runPromise(f.make);
    const path = required(await Effect.runPromise(api.capture(cursor, "local")));
    const command = f.spawn.mock.calls[0]?.[0] as unknown as { command: string; args: string[] };
    expect(command.command).toBe("/same-agent");
    expect(command.args).toEqual(["-e", "https://private.endpoint", "about", "--format", "json"]);
    expect(f.read).not.toHaveBeenCalled();
    expect(JSON.stringify(path)).not.toMatch(/person@|private.endpoint/);
  });

  it("requires authenticated Claude subscription email and org from the same binary", async () => {
    const f = fixture();
    f.state.stdout = JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "person@private.example",
      orgId: "org-private",
    });
    const api = await Effect.runPromise(f.make);
    const path = required(await Effect.runPromise(api.capture(claude, "local")));
    const command = f.spawn.mock.calls[0]?.[0] as unknown as { command: string; args: string[] };
    expect(command).toMatchObject({ command: "/same-claude", args: ["auth", "status", "--json"] });
    expect(JSON.stringify(path)).not.toMatch(/person@|org-private/);
    f.state.stdout = JSON.stringify({
      loggedIn: false,
      authMethod: "claude.ai",
      email: "person@private.example",
      orgID: "org-private",
    });
    expect(await Effect.runPromise(api.capture(claude, "local"))).toBeNull();
    f.state.stdout = JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "person@private.example",
    });
    expect(await Effect.runPromise(api.capture(claude, "local"))).toBeNull();
    vi.stubEnv("ANTHROPIC_API_KEY", "alternate-key");
    expect(await Effect.runPromise(api.capture(claude, "local"))).toBeNull();
  });

  it("retains org-ID authority and separately rechecks the SDK-comparable org-name proof", async () => {
    const f = fixture();
    const auth = {
      loggedIn: true,
      authMethod: "claude.ai",
      email: "person@private.example",
      orgId: "org-private",
      orgName: "private-name",
    };
    f.state.stdout = JSON.stringify(auth);
    const api = await Effect.runPromise(f.make);
    const path = required(await Effect.runPromise(api.capture(claude, "local")));
    expect(path.nativeAccountIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(path.nativeAccountIdentity).not.toBe(path.accountIdentity);
    expect(JSON.stringify(path)).not.toMatch(/person@|org-private|private-name/);
    for (const changed of [
      { ...auth, orgName: "different" },
      { ...auth, orgId: "different" },
    ]) {
      f.state.stdout = JSON.stringify(changed);
      expect(await Effect.runPromise(api.providerSettings(context, path))).toBeNull();
      const claim = vi.fn();
      const result = await Effect.runPromise(
        api
          .withExecutionIdentity(context, path, f.snapshot(), Effect.sync(claim))
          .pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      expect(claim).not.toHaveBeenCalled();
    }
  });

  it.each(["{}", "not JSON", '{"userEmail":null}', '{"userEmail":"not logged in"}'])(
    "fails closed on unprovable Cursor payload %s",
    async (stdout) => {
      const f = fixture();
      f.state.stdout = stdout;
      const api = await Effect.runPromise(f.make);
      expect(await Effect.runPromise(api.capture(cursor, "local"))).toBeNull();
    },
  );

  it("fingerprints all selection options, binary, enabled config and endpoint", async () => {
    const f = fixture();
    const api = await Effect.runPromise(f.make);
    const first = required(await Effect.runPromise(api.capture(codex, "local")));
    const second = required(
      await Effect.runPromise(
        api.capture({ ...codex, options: { reasoningEffort: "low" } }, "local"),
      ),
    );
    expect(first.transport).not.toBe(second.transport);
    f.current.providers.codex.binaryPath = "/different-codex";
    expect(await Effect.runPromise(api.providerSettings(context, first))).toBeNull();
    const cursorPath = required(await Effect.runPromise(api.capture(cursor, "local")));
    f.current.providers.cursor.apiEndpoint = "https://changed.endpoint";
    expect(await Effect.runPromise(api.providerSettings(context, cursorPath))).toBeNull();
    f.current.providers.cursor.enabled = false;
    expect(await Effect.runPromise(api.providerSettings(context, cursorPath))).toBeNull();
  });

  it("preserves execution authority when only discovery custom models change", async () => {
    const f = fixture();
    const api = await Effect.runPromise(f.make);
    const path = required(await Effect.runPromise(api.capture(codex, "local")));
    f.current.providers.codex.customModels = ["new-discovered-model"];
    expect(await Effect.runPromise(api.capture(codex, "local"))).toEqual(path);
    expect(await Effect.runPromise(api.providerSettings(context, path))).not.toBeNull();
    const claim = vi.fn();
    await Effect.runPromise(
      api.withExecutionIdentity(context, path, f.snapshot(), Effect.sync(claim)),
    );
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("returns cloned settings only for current transport, target and account", async () => {
    const f = fixture();
    const api = await Effect.runPromise(f.make);
    const path = required(await Effect.runPromise(api.capture(codex, "local")));
    const providers = await Effect.runPromise(api.providerSettings(context, path));
    expect(providers).toEqual(f.current.providers);
    expect(providers).not.toBe(f.current.providers);
    expect(providers?.codex).not.toBe(f.current.providers.codex);
    expect(
      await Effect.runPromise(
        api.providerSettings(context, { ...path, executionTarget: "remote" }),
      ),
    ).toBeNull();
    expect(
      await Effect.runPromise(
        api.providerSettings(context, {
          ...path,
          selection: { ...codex, options: { reasoningEffort: "low" } },
        }),
      ),
    ).toBeNull();
    f.state.auth = JSON.stringify({ tokens: { account_id: "changed-account" } });
    expect(await Effect.runPromise(api.providerSettings(context, path))).toBeNull();
  });

  it("revalidates actual account and exact snapshot before claiming; errors contain no secrets", async () => {
    const f = fixture();
    const api = await Effect.runPromise(f.make);
    const path = required(await Effect.runPromise(api.capture(codex, "local")));
    const claim = vi.fn();
    await Effect.runPromise(
      api.withExecutionIdentity(context, path, f.snapshot(), Effect.sync(claim)),
    );
    expect(claim).toHaveBeenCalledTimes(1);
    f.state.auth = JSON.stringify({ tokens: { account_id: "changed-account" } });
    const result = await Effect.runPromise(
      api
        .withExecutionIdentity(context, path, f.snapshot(), Effect.sync(claim))
        .pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).not.toMatch(/account-private|changed-account/);
    expect(claim).toHaveBeenCalledTimes(1);
    f.current.providers.codex.binaryPath = "/changed";
    expect(
      (
        await Effect.runPromise(
          api
            .withExecutionIdentity(context, path, f.snapshot(), Effect.sync(claim))
            .pipe(Effect.result),
        )
      )._tag,
    ).toBe("Failure");
  });

  it("holds short identity authority through claim and fails busy admission closed", async () => {
    const f = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* f.make;
        const path = required(yield* api.capture(codex, "local"));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const first = yield* api
          .withExecutionIdentity(
            context,
            path,
            f.snapshot(),
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const claim = vi.fn();
        const busy = yield* api
          .withExecutionIdentity(context, path, f.snapshot(), Effect.sync(claim))
          .pipe(Effect.result);
        expect(busy._tag).toBe("Failure");
        expect(claim).not.toHaveBeenCalled();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* api.withExecutionIdentity(context, path, f.snapshot(), Effect.sync(claim));
        expect(claim).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it("bounds mocked probes below one second and sanitizes crashes/nonzero exits/oversize output", async () => {
    const f = fixture();
    const api = await Effect.runPromise(f.make);
    f.state.hang = true;
    const started = Date.now();
    expect(await Effect.runPromise(api.capture(cursor, "local"))).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    f.state.hang = false;
    f.state.crash = true;
    expect(await Effect.runPromise(api.capture(cursor, "local"))).toBeNull();
    f.state.crash = false;
    f.state.code = 1;
    expect(await Effect.runPromise(api.capture(cursor, "local"))).toBeNull();
    f.state.code = 0;
    f.state.stdout = JSON.stringify({
      userEmail: "person@private.example",
      extra: "x".repeat(65_536),
    });
    expect(await Effect.runPromise(api.capture(cursor, "local"))).toBeNull();
  });
});
