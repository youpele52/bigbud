import path from "node:path";
import { readFile } from "node:fs/promises";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import { v2ManagedPluginFilename } from "./PluginSetup.record.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import type { OpencodeV2Client } from "./Client.ts";
import type { V2ThreadOwner } from "./Orchestration.protocol.ts";

/** Native SDK/watch simulation only; production installation, source proof and generated RPC stay real. */
export function wireV2AutomaticNativeFixture(input: {
  artifact: V2PluginSetupArtifact;
  client: OpencodeV2Client;
  root: string;
  owner: V2ThreadOwner;
  legacyFile?: string;
}) {
  const { artifact, client, root } = input,
    selected = v2ThreadRegistration(artifact);
  const host = makeV2ThreadPluginHost(input.owner);
  const filename = path.join(root, "plugins", v2ManagedPluginFilename(artifact));
  let dispose: (() => Promise<void>) | undefined,
    foreground = false,
    shell = false,
    activeReads = 0;
  Object.assign(client, {
    session: {
      active: async () => {
        activeReads++;
        return foreground ? { retained: { type: "running" } } : {};
      },
    },
    debug: { location: { list: async () => [{ directory: input.owner.directory }] } },
    shell: {
      list: async ({ location }: { location: { directory: string } }) => ({
        location,
        data: shell ? [{ status: "running" }] : [],
      }),
    },
    plugin: {
      list: async () => {
        const published = await readFile(filename, "utf8").catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (published && !dispose) {
          if (!published.includes(artifact.entryUri))
            throw new Error("Synthetic watcher saw another artifact.");
          dispose = await (
            await import(/* @vite-ignore */ artifact.entryUri)
          ).default.setup(host.context);
        }
        return {
          location: { directory: input.owner.directory },
          data: [
            ...(input.legacyFile
              ? [
                  {
                    id: "bigbud.thread.v1",
                    source: { type: "local", path: input.legacyFile },
                    state: { status: "active" },
                  },
                ]
              : []),
            ...(dispose
              ? [
                  {
                    id: selected.id,
                    source: { type: "local", path: filename },
                    state: { status: "active" },
                  },
                ]
              : []),
          ],
        };
      },
    },
    rpc: {
      call: async (request: { rpcID: string; method: string; input: unknown }) => {
        if (request.rpcID !== selected.id) throw new Error("Synthetic foreign RPC rejected.");
        return { output: await host.call(request.method, request.input) };
      },
    },
  });
  return {
    host,
    filename,
    get activeReads() {
      return activeReads;
    },
    busy: (value: "foreground" | "shell" | undefined) => {
      foreground = value === "foreground";
      shell = value === "shell";
    },
    close: async () => {
      await dispose?.();
    },
  };
}
