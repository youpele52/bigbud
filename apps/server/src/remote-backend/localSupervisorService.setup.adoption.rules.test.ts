import { expect, it } from "vitest";
import {
  emptyRemoteAgentRegistry,
  type RemoteAgentRegistry,
  type RemoteAgentRegistryBuild,
} from "../remote-agent/remoteAgentInstall.registry.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import {
  SETUP_ADOPTION_REFUSAL_CODES,
  assertAdoptionCapacity,
  assessAdoptableRegistry,
  findSetupAdoptionRefusal,
  formatSetupRefusalLine,
  LocalSupervisorSetupAdoptionRefusal,
  parseSetupRefusalCode,
} from "./localSupervisorService.setup.adoption.rules.ts";

const build = (sha: string): RemoteAgentRegistryBuild => {
  const root = "/home/u/.bigbud/agent",
    state = `${root}/runtimes/g-${sha.slice(0, 24)}`;
  const runtime: RemoteAgentRuntime = {
    generation: `g-${sha.slice(0, 24)}`,
    version: "1.0.0",
    sha256: sha,
    buildDigest: "digest",
    targetTriple: "aarch64-unknown-linux-musl",
    binaryPath: `${root}/bin/1.0.0/${sha}/bigbud-remote-agent`,
    statePath: state,
    socketPath: `${state}/supervisor.sock`,
    logPath: `${state}/supervisor.log`,
    origin: "managed",
  };
  return {
    id: `1.0.0:${sha}:${runtime.targetTriple}`,
    runtime,
    health: "healthy",
    promotion: 1,
    binary: "present",
    authenticated: true,
  };
};
const a = build("a".repeat(64)),
  b = build("b".repeat(64));
const registry = (patch: Partial<RemoteAgentRegistry> = {}): RemoteAgentRegistry =>
  ({
    ...emptyRemoteAgentRegistry(),
    builds: [a],
    pins: [
      { owner: "connection:laptop-1", buildId: a.id },
      { owner: "terminal:pty-1", buildId: a.id },
    ],
    current: a.id,
    ...patch,
  }) as RemoteAgentRegistry;
const code = (run: () => unknown) => {
  try {
    run();
  } catch (cause) {
    return findSetupAdoptionRefusal(cause)?.code;
  }
  return "adopted";
};

it("keeps every recorded connection pin for an adoptable registry", () => {
  const assessed = assessAdoptableRegistry(registry());
  expect(assessed.presentBuilds).toEqual([a]);
  expect([...assessed.connectionIds]).toEqual(["laptop-1"]);
});

it.each([
  ["deleting binary", { builds: [{ ...a, binary: "deleting" as const }] }, "install-in-progress"],
  ["pending build", { pending: a.id }, "install-in-progress"],
  [
    "open retirement",
    {
      retirementReservations: [
        { id: "r", buildId: a.id, generation: "g", phase: "fenced" as const },
      ],
    },
    "install-in-progress",
  ],
  [
    "unsettled launch",
    { launches: [{ id: "g", buildId: a.id, phase: "spawn-uncertain" as const, epoch: "" }] },
    "ambiguous-state",
  ],
  ["pin on a missing build", { pins: [{ owner: "x", buildId: b.id }] }, "ambiguous-state"],
  [
    "external runtime",
    { builds: [{ ...a, runtime: { ...a.runtime, origin: "legacy-external" as const } }] },
    "legacy-owner",
  ],
] as const)("refuses a registry with %s", (_name, patch, expected) => {
  expect(code(() => assessAdoptableRegistry(registry(patch)))).toBe(expected);
});

it("refuses a third build only when two others occupy the account", () => {
  const c = build("c".repeat(64));
  expect(code(() => assertAdoptionCapacity([a, b], new Set([c.id])))).toBe("no-capacity");
  expect(code(() => assertAdoptionCapacity([a, b], new Set([a.id])))).toBe("adopted");
  expect(code(() => assertAdoptionCapacity([a], new Set([c.id])))).toBe("adopted");
});

it("round-trips only known refusal codes through the CLI line", () => {
  for (const known of SETUP_ADOPTION_REFUSAL_CODES)
    expect(
      parseSetupRefusalCode(
        formatSetupRefusalLine(
          new LocalSupervisorSetupAdoptionRefusal({ code: known, message: "m" }),
        ),
      ),
    ).toBe(known);
  expect(parseSetupRefusalCode("bigbud backend: Setup refused (made-up): x")).toBeUndefined();
});
