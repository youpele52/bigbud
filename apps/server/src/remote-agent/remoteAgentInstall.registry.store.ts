import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import {
  buildRemoteAgentRegistryCas,
  buildRemoteAgentRegistryRead,
} from "./remoteAgentInstall.registry.shell.ts";
import { assertMobileRegistryTransition } from "./remoteAgentInstall.mobile.invariants.ts";

export interface RemoteAgentRegistryCommand {
  readonly run: (command: string) => Promise<string>;
}

/** Cross-controller CAS; lost acknowledgements reconcile content before reporting a failed write. */
export function makeRemoteAgentRegistryStore(root: string, command: RemoteAgentRegistryCommand) {
  const read = async () => {
    const output = (await command.run(buildRemoteAgentRegistryRead(root))).trim();
    if (output === "missing") return { text: null, state: emptyRemoteAgentRegistry() };
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(output)) throw new Error("Invalid registry response.");
    const text = Buffer.from(output, "base64").toString("utf8");
    return { text, state: parseRemoteAgentRegistry(text) };
  };
  return {
    read: async () => (await read()).state,
    update: async (transition: (state: RemoteAgentRegistry) => RemoteAgentRegistry) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const before = await read();
        const beforeCanonical = JSON.stringify(before.state);
        const beforeRevision = before.state.revision;
        const next = transition(before.state);
        const text = JSON.stringify(next);
        const canonical = parseRemoteAgentRegistry(text);
        assertMobileRegistryTransition(beforeCanonical, canonical);
        if (next === before.state) {
          if (text !== beforeCanonical) throw new Error("In-place registry transition mutation.");
          return canonical;
        }
        if (canonical.revision !== beforeRevision + 1)
          throw new Error("Invalid registry transition revision.");
        let result: string;
        try {
          result = (
            await command.run(
              buildRemoteAgentRegistryCas({ root, expected: before.text, next: text }),
            )
          ).trim();
        } catch (cause) {
          // A failed reply does not undo rename. Leave all intents/pins until reconciliation.
          const observed = await read();
          if (observed.text === text) return observed.state;
          throw cause;
        }
        if (result === "committed") return canonical;
        if (result !== "conflict")
          throw new Error("Unknown registry publication result; reconcile intent before retry.");
      }
      throw new Error("Registry contention exceeded the bounded retry budget.");
    },
  };
}
