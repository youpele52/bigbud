import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import * as Path from "node:path";

import type { ServerProvider } from "@bigbud/contracts";
import type { CopilotRuntimeState } from "@bigbud/contracts/server/copilotRuntime.ts";
import type { ProvisionableProviderKind } from "@bigbud/contracts/server/providerProvisioning.ts";
import { vi } from "vitest";

import type { ProvisioningEnvironment } from "./provision.ts";
import type { ServicePathDiscovery } from "./servicePath.ts";

export const USER_PROVIDERS = [
  "codex",
  "claudeAgent",
  "cliProxy",
  "cursor",
  "devin",
  "muse",
  "opencodeV2",
] as const satisfies ReadonlyArray<ProvisionableProviderKind>;

export function writeExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = Path.join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

export function discoveryOf(dir: string): ServicePathDiscovery {
  return { path: dir, entries: [{ dir, source: "loginShell" }], shell: { status: "skipped" } };
}

export function snapshot(
  provider: ProvisionableProviderKind,
  overrides: Partial<Pick<ServerProvider, "enabled" | "installed" | "status" | "auth">> = {},
): ServerProvider {
  return {
    provider,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-18T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as unknown as ServerProvider;
}

export function copilotState(overrides: Partial<CopilotRuntimeState> = {}): CopilotRuntimeState {
  return {
    available: false,
    source: "missing",
    path: null,
    version: null,
    installedSizeBytes: null,
    managed: [],
    activeLeases: 0,
    onboarding: false,
    pinnedVersion: "1.0.105",
    job: null,
    error: null,
    diagnostic: null,
    ...overrides,
  };
}

export function makeEnvironment(
  input: {
    readonly dir: string;
    readonly remote?: boolean;
    readonly settings?: Record<string, string>;
    readonly snapshots?: ReadonlyArray<ServerProvider>;
    readonly piClosure?: string;
    readonly copilot?: CopilotRuntimeState;
  } = { dir: "/nonexistent" },
) {
  const install = vi.fn(async () =>
    copilotState({
      job: {
        operation: "install",
        id: "job-1",
        phase: "downloading",
        version: "1.0.105",
        transferredBytes: 0,
        totalBytes: 1,
        error: null,
      },
    }),
  );
  const status = vi.fn(async () => input.copilot ?? copilotState());
  const environment: ProvisioningEnvironment = {
    remote: input.remote ?? true,
    tuple: { os: "linux", arch: "x64", libc: "glibc" },
    discovery: discoveryOf(input.dir),
    configuredValue: (key) => input.settings?.[key],
    snapshot: (kind) => input.snapshots?.find((entry) => entry.provider === kind),
    piClosurePath: () => input.piClosure,
    copilot: { status, install },
  };
  return { environment, install, status };
}
