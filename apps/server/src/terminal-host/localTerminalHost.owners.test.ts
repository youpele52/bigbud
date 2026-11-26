import { describe, expect, it } from "vitest";

import { pinRemoteAgentBuild } from "../remote-agent/remoteAgentInstall.registry.transitions.ts";
import { remoteAgentBuildId } from "../remote-agent/remoteAgentRuntime.ts";
import { makeLocalTerminalHostPinRegistry } from "./localTerminalHost.owners.ts";
import { localTerminalHostGenerationPaths } from "./localTerminalHost.paths.ts";
import { fakeHostHello } from "./localTerminalHost.testUtils.ts";
import { localTerminalHostBinding } from "./localTerminalHost.transport.ts";

const runtime = (generation: number) =>
  localTerminalHostBinding(
    localTerminalHostGenerationPaths("/tmp/bbth-x/terminal-host", generation),
    fakeHostHello({ buildDigest: `digest-${generation}` }),
    "/staged/bigbud-remote-agent",
  ).runtime;

describe("local terminal host pin registry", () => {
  it("pins owners against every adopted generation through the registry validator", async () => {
    const runtimes = [runtime(1)];
    const registry = makeLocalTerminalHostPinRegistry(async () => runtimes);
    const first = await registry.update((state) =>
      pinRemoteAgentBuild(state, "terminal:a:1", remoteAgentBuildId(runtimes[0]!)),
    );
    expect(first.builds.map((build) => build.promotion)).toEqual([1]);
    runtimes.push(runtime(2));
    const second = await registry.update((state) =>
      pinRemoteAgentBuild(state, "terminal:b:2", remoteAgentBuildId(runtimes[1]!)),
    );
    expect(second.promotionSequence).toBe(2);
    expect(second.pins.map((pin) => pin.owner)).toEqual(["terminal:a:1", "terminal:b:2"]);
  });
});
