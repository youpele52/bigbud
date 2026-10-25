import type {
  ServerProvider,
  ServerDiscoveredAgent,
} from "@bigbud/contracts/server/server.providers.ts";
import { expect, it } from "vitest";
import { buildNativeDiscoveryEntries } from "./DiscoveryRegistry.native.ts";
import {
  opencodeAgentSystemHash,
  opencodeMarkdownAgentSystemHash,
} from "../opencodeAgentSource.ts";

const system = "Watch the task and report blockers.";
const systemPromptHash = opencodeAgentSystemHash(system);
const provider: ServerProvider = {
  provider: "opencodeV2",
  enabled: true,
  installed: true,
  version: "2.0.32",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-10-20T00:00:00Z",
  models: [],
  slashCommands: [],
  skills: [],
  nativeAgents: [{ id: "babysitter", name: "babysitter", systemPromptHash }],
};
function file(path: string, body = system, name = "babysitter") {
  return {
    kind: "agent" as const,
    systemPromptHash: opencodeMarkdownAgentSystemHash(`---\nmode: subagent\n---\n${body}`),
    entry: {
      id: `opencode:agent:${name}`,
      provider: "opencode" as const,
      name,
      source: "user" as const,
      sourcePath: path,
    },
  };
}

it("reproduces native babysitter lacking a path and resolves its verified Markdown source", () => {
  const source = file("/home/user/.config/opencode/agents/babysitter.md");
  const originalNative: ServerDiscoveredAgent = {
    id: "opencodeV2:native:babysitter",
    provider: "opencodeV2",
    name: "babysitter",
    source: "config",
  };
  expect(originalNative.sourcePath).toBeUndefined();
  const catalog = buildNativeDiscoveryEntries(provider, [source]);
  expect(catalog.agents[0]).toMatchObject({
    provider: "opencodeV2",
    name: "babysitter",
    source: "user",
    sourcePath: source.entry.sourcePath,
  });
});

it("does not attach a same-name file overridden by native config or plugins", () => {
  expect(
    buildNativeDiscoveryEntries(provider, [file("/wrong.md", "Overridden instructions.")]).agents[0]
      ?.sourcePath,
  ).toBeUndefined();
});

it("does not invent a source for generated agents or agents without a prompt fingerprint", () => {
  const generated = { ...provider, nativeAgents: [{ id: "babysitter", name: "babysitter" }] };
  expect(
    buildNativeDiscoveryEntries(generated, [file("/name-only.md")]).agents[0]?.sourcePath,
  ).toBeUndefined();
  expect(buildNativeDiscoveryEntries(provider, []).agents[0]?.sourcePath).toBeUndefined();
});

it("does not choose arbitrarily between distinct files with identical instructions", () => {
  expect(
    buildNativeDiscoveryEntries(provider, [file("/a/babysitter.md"), file("/b/babysitter.md")])
      .agents[0]?.sourcePath,
  ).toBeUndefined();
});

it("requires the same native agent identity as well as identical instructions", () => {
  expect(
    buildNativeDiscoveryEntries(provider, [file("/other.md", system, "other")]).agents[0]
      ?.sourcePath,
  ).toBeUndefined();
});
