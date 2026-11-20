import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestSettings } from "../../ws/serverSettings.testing.ts";
import { makeMetadataExecutionIdentity } from "./ThreadMetadataGeneration.executionIdentity.ts";
import { evidenceFixture } from "./ThreadMetadataGeneration.identity.test-helpers.ts";

const probe = vi.hoisted(() => ({
  account:
    vi.fn<
      (
        binary: string,
        environment: NodeJS.ProcessEnv,
        signal: AbortSignal,
      ) => Promise<string | null>
    >(),
  transport: vi.fn(() => "transport-A"),
}));
vi.mock("./ThreadMetadataGeneration.copilotIdentity.ts", () => ({
  probeMetadataCopilotAccount: probe.account,
  copilotMetadataTransport: probe.transport,
}));

function fixture(enabled = true) {
  const defaults = structuredClone(DEFAULT_SERVER_SETTINGS);
  const settings = {
    ...defaults,
    providers: {
      ...defaults.providers,
      copilot: { ...defaults.providers.copilot, enabled, binaryPath: "/mock/copilot" },
    },
  };
  const read = vi.fn(() => Effect.die("Unexpected credential file read"));
  const spawn = vi.fn(() => Effect.die("Unexpected external CLI probe"));
  const api = () =>
    Effect.runPromise(
      makeTestSettings(settings).pipe(
        Effect.flatMap(makeMetadataExecutionIdentity),
        Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({ readFileString: read })),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(spawn),
        ),
      ),
    );
  const context = evidenceFixture().context;
  return { api, settings, context, read, spawn, snapshot: () => ({ revision: 1, settings }) };
}

beforeEach(() => {
  probe.account.mockReset().mockResolvedValue("a".repeat(64));
  probe.transport.mockReset().mockReturnValue("transport-A");
});

describe("Copilot metadata execution identity", () => {
  it("uses only the isolated SDK probe and preserves its opaque account fingerprint", async () => {
    const f = fixture();
    const identity = await f.api();
    const path = await Effect.runPromise(
      identity.capture(f.context.primaryPath!.selection, "local"),
    );
    expect(path).toMatchObject({ accountIdentity: "a".repeat(64), transport: "transport-A" });
    expect(path?.nativeAccountIdentity).toBeUndefined();
    expect(probe.account).toHaveBeenCalledWith(
      "/mock/copilot",
      expect.any(Object),
      expect.any(AbortSignal),
    );
    expect(f.read).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(JSON.stringify(path)).not.toContain("/mock/copilot");
  });

  it.each(["remote", "disabled"])("does not probe %s execution", async (condition) => {
    const f = fixture(condition !== "disabled");
    const identity = await f.api();
    expect(
      await Effect.runPromise(
        identity.capture(
          f.context.primaryPath!.selection,
          condition === "remote" ? "remote:fixture" : "local",
        ),
      ),
    ).toBeNull();
    expect(probe.account).not.toHaveBeenCalled();
  });

  it.each(["missing", "error"])("fails closed on %s account proof", async (kind) => {
    if (kind === "missing") probe.account.mockResolvedValue(null);
    else probe.account.mockRejectedValue(new Error("private runtime diagnostic"));
    const f = fixture();
    const identity = await f.api();
    expect(
      await Effect.runPromise(identity.capture(f.context.primaryPath!.selection, "local")),
    ).toBeNull();
  });

  it("refuses a runtime that changes during the account probe", async () => {
    probe.account.mockImplementation(async () => {
      probe.transport.mockReturnValue("transport-B");
      return "a".repeat(64);
    });
    const f = fixture();
    const identity = await f.api();
    expect(
      await Effect.runPromise(identity.capture(f.context.primaryPath!.selection, "local")),
    ).toBeNull();
  });

  it("rechecks account and runtime before returning executable settings", async () => {
    const f = fixture();
    const identity = await f.api();
    const path = (await Effect.runPromise(
      identity.capture(f.context.primaryPath!.selection, "local"),
    ))!;
    expect(await Effect.runPromise(identity.providerSettings(f.context, path))).toEqual(
      f.settings.providers,
    );
    probe.account.mockResolvedValue("b".repeat(64));
    expect(await Effect.runPromise(identity.providerSettings(f.context, path))).toBeNull();
    probe.account.mockImplementation(async () => {
      probe.transport.mockReturnValue("transport-B");
      return "a".repeat(64);
    });
    expect(await Effect.runPromise(identity.providerSettings(f.context, path))).toBeNull();
  });

  it("does not claim paid dispatch when runtime changes during the final identity check", async () => {
    const f = fixture();
    const identity = await f.api();
    const path = (await Effect.runPromise(
      identity.capture(f.context.primaryPath!.selection, "local"),
    ))!;
    const claimed = vi.fn();
    probe.account.mockImplementation(async () => {
      probe.transport.mockReturnValue("transport-B");
      return "a".repeat(64);
    });
    const result = await Effect.runPromise(
      identity
        .withExecutionIdentity(f.context, path, f.snapshot(), Effect.sync(claimed))
        .pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    expect(claimed).not.toHaveBeenCalled();
  });

  it("times out an account probe and aborts it without launching any generation", async () => {
    let signal: AbortSignal | undefined;
    probe.account.mockImplementation((_binary, _environment, captured) => {
      signal = captured;
      return new Promise(() => {});
    });
    const f = fixture();
    const identity = await f.api();
    expect(
      await Effect.runPromise(identity.capture(f.context.primaryPath!.selection, "local")),
    ).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(f.spawn).not.toHaveBeenCalled();
  });
});
