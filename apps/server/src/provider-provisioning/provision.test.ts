import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vendorStarts = vi.hoisted(() => ({ borrow: vi.fn(), start: vi.fn() }));
// Borrow-only: neither the shared-service borrow nor an owned OpenCode process may start.
vi.mock("../provider/Layers/OpencodeV2/SharedService.connection.ts", () => ({
  borrowV2SharedService: vendorStarts.borrow,
}));
vi.mock("../provider/Layers/OpencodeV2/ServerManager.child.ts", () => ({
  startOwnedV2Process: vendorStarts.start,
}));

import {
  providerProvisioningEntry,
  providerProvisioningStatus,
  provisionProvider,
} from "./provision.ts";
import {
  copilotState,
  makeEnvironment,
  snapshot,
  USER_PROVIDERS,
  writeExecutable,
} from "./provision.test.helpers.ts";
import { PROVIDER_RECIPES } from "./recipes/index.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(Path.join(tmpdir(), "bigbud-provision-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("provider provisioning status", () => {
  it("needs_auth_distinct_from_missing", async () => {
    const missing = makeEnvironment({ dir, snapshots: [snapshot("codex")] });
    const absent = await Effect.runPromise(providerProvisioningEntry("codex", missing.environment));
    expect(absent.state).toBe("missing");

    writeExecutable(dir, "codex");
    const unauthenticated = makeEnvironment({
      dir,
      snapshots: [snapshot("codex", { status: "error", auth: { status: "unauthenticated" } })],
    });
    const needsAuth = await Effect.runPromise(
      providerProvisioningEntry("codex", unauthenticated.environment),
    );
    expect(needsAuth).toMatchObject({
      state: "needs-auth",
      executablePath: Path.join(dir, "codex"),
      executableSource: "discovered",
      authStep: "codex login",
      authCheck: "provider/Layers/Codex/Provider.ts#checkCodexProviderStatus",
    });

    const ready = makeEnvironment({ dir, snapshots: [snapshot("codex")] });
    expect(
      (await Effect.runPromise(providerProvisioningEntry("codex", ready.environment))).state,
    ).toBe("ready");
    // A readiness check that could not start the tool also reports missing, never needs-auth.
    const failedStart = makeEnvironment({
      dir,
      snapshots: [snapshot("codex", { installed: false, auth: { status: "unauthenticated" } })],
    });
    expect(
      (await Effect.runPromise(providerProvisioningEntry("codex", failedStart.environment))).state,
    ).toBe("missing");
  });

  it("explicit configured paths are kept as-is, even when absent", async () => {
    const { environment } = makeEnvironment({
      dir,
      settings: { "providers.cursor.binaryPath": "/opt/custom/agent" },
      snapshots: [snapshot("cursor")],
    });
    const entry = await Effect.runPromise(providerProvisioningEntry("cursor", environment));
    expect(entry).toMatchObject({
      executablePath: "/opt/custom/agent",
      executableSource: "explicit",
    });
  });

  it("reports unsupported remote tuples without installing", async () => {
    const { environment, install } = makeEnvironment({ dir });
    const musl = { ...environment, tuple: { os: "linux", arch: "x64", libc: "musl" } as const };
    const result = await Effect.runPromise(provisionProvider("pi", musl));
    expect(result.outcome).toBe("unsupported");
    expect(install).not.toHaveBeenCalled();
  });
});

describe("provider provision action", () => {
  it.each(USER_PROVIDERS)(
    "needs-install for %s shows the recipe's exact commands",
    async (kind) => {
      const { environment, install, status } = makeEnvironment({ dir });
      const result = await Effect.runPromise(provisionProvider(kind, environment));
      expect(result.outcome).toBe("needs-install");
      expect(result.entry.state).toBe("missing");
      expect(result.entry.manualCommands).toEqual(PROVIDER_RECIPES[kind].manual.installCommands);
      expect(result.entry.manualCommands.length).toBeGreaterThan(0);
      for (const command of result.entry.manualCommands)
        expect(command).not.toMatch(/\|\s*(ba|z)?sh\b/);
      expect(result.copilotJob).toBeNull();
      expect(install).not.toHaveBeenCalled();
      expect(status).not.toHaveBeenCalled();
    },
  );

  it("opencodeV2_borrow_only_never_starts_service", async () => {
    writeExecutable(dir, "opencode");
    for (const snapshots of [
      [],
      [snapshot("opencodeV2", { status: "error", auth: { status: "unknown" } })],
      [snapshot("opencodeV2", { status: "error", auth: { status: "unauthenticated" } })],
    ]) {
      const { environment, install } = makeEnvironment({ dir, snapshots });
      const statuses = await Effect.runPromise(
        providerProvisioningStatus(environment, "opencodeV2"),
      );
      const result = await Effect.runPromise(provisionProvider("opencodeV2", environment));
      expect(statuses[0]!.executablePath).toBe(Path.join(dir, "opencode"));
      expect(result.outcome).not.toBe("installing");
      expect(install).not.toHaveBeenCalled();
    }
    expect(vendorStarts.borrow).not.toHaveBeenCalled();
    expect(vendorStarts.start).not.toHaveBeenCalled();
  });

  it("Pi is satisfied by the graph closure and installs nothing", async () => {
    const closure = Path.join(dir, "cli.js");
    const { environment, install } = makeEnvironment({
      dir,
      piClosure: closure,
      snapshots: [snapshot("pi")],
    });
    const result = await Effect.runPromise(provisionProvider("pi", environment));
    expect(result).toMatchObject({ outcome: "available", copilotJob: null });
    expect(result.entry).toMatchObject({ executablePath: closure, executableSource: "bundled" });
    const absent = makeEnvironment({ dir });
    expect((await Effect.runPromise(provisionProvider("pi", absent.environment))).outcome).toBe(
      "needs-install",
    );
    expect(install).not.toHaveBeenCalled();
    expect(absent.install).not.toHaveBeenCalled();
  });

  it("Copilot installs the pinned runtime only when missing and not explicitly configured", async () => {
    const missing = makeEnvironment({ dir });
    const started = await Effect.runPromise(provisionProvider("copilot", missing.environment));
    expect(started.outcome).toBe("installing");
    expect(started.copilotJob?.phase).toBe("downloading");
    expect(missing.install).toHaveBeenCalledTimes(1);

    const explicit = makeEnvironment({
      dir,
      settings: { "providers.copilot.binaryPath": "/opt/copilot" },
    });
    const kept = await Effect.runPromise(provisionProvider("copilot", explicit.environment));
    expect(kept.outcome).toBe("needs-install");
    expect(explicit.install).not.toHaveBeenCalled();

    const installed = makeEnvironment({
      dir,
      copilot: copilotState({ available: true, source: "managed", path: "/m/copilot" }),
      snapshots: [snapshot("copilot", { auth: { status: "unauthenticated" } })],
    });
    const present = await Effect.runPromise(provisionProvider("copilot", installed.environment));
    expect(present).toMatchObject({ outcome: "needs-auth", copilotJob: null });
    expect(present.entry).toMatchObject({ executableSource: "managed", authStep: "gh auth login" });
    expect(installed.install).not.toHaveBeenCalled();
  });
});
