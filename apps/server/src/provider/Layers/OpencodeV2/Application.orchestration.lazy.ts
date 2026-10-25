import { makeV2ApplicationOrchestration } from "./Application.orchestration.ts";
import type { V2ThreadBridge } from "./Orchestration.bridge.ts";
import type { V2ThreadToolsActivation } from "./PluginSetup.activation.ts";
import type { V2ActivationJobScope } from "./PluginSetup.activation.jobs.ts";
import { assertV2PreviousHistoryRetired } from "./Orchestration.enrollment.recovery.ts";
import type { V2BackendInstance } from "./Orchestration.instances.ts";
import {
  selectV2SessionArtifact,
  type V2SessionRegistrationIdentity,
} from "./Orchestration.selection.ts";

/** Required execution infrastructure is lazy, not optional: catalog discovery stays truthful when setup/storage fails. */
export function makeV2RequiredOrchestration(
  stateDir: string,
  activation: V2ThreadToolsActivation,
  descriptor: V2ActivationJobScope["descriptor"],
  backend?: V2BackendInstance,
) {
  const setup: Parameters<typeof makeV2ApplicationOrchestration>[1] = (
    artifact,
    client,
    directory,
    signal,
  ) => activation.awaitReady(artifact, descriptor, client, directory, signal);
  let initialized: Promise<Awaited<ReturnType<typeof makeV2ApplicationOrchestration>>> | undefined;
  let closed = false;
  const acquire = async () => {
    if (closed) throw new Error("V2 required thread-tools broker is closed.");
    initialized ??= makeV2ApplicationOrchestration(
      stateDir,
      setup,
      activation.nativeEligibility,
      undefined,
      backend,
    )
      .then(async (value) => {
        if (closed) {
          await value.close();
          throw new Error("V2 required thread-tools broker was disposed during initialization.");
        }
        return value;
      })
      .catch(() => {
        throw new Error(
          "V2 required thread-tools private app infrastructure is unavailable. Correct app-owned storage and restart bigbud; native models/history were not changed.",
        );
      });
    return initialized;
  };
  const bridge: Pick<V2ThreadBridge, "attach" | "ensure" | "reply" | "close"> = {
    attach: async (session, runtime) => (await acquire()).bridge.attach(session, runtime),
    ensure: async (session) => (await acquire()).bridge.ensure(session),
    reply: async (runtime, session, id, decision) =>
      (await acquire()).bridge.reply(runtime, session, id, decision),
    close: () => {
      closed = true;
      void initialized?.then((value) => value.bridge.close()).catch(() => {});
    },
  };
  return {
    bridge,
    issuer: async () => (await acquire()).artifact.issuer,
    activation: {
      coordinator: activation,
      beforeSharedHistory: async ({
        client,
        transport,
        ...scope
      }: {
        storageIdentity: string;
        nativeSessionId: string;
        threadId: string;
        directory: string;
        client?: Parameters<V2ThreadBridge["attach"]>[0]["lease"]["process"]["client"];
        transport?: string;
      }) => {
        const broker = await acquire();
        return assertV2PreviousHistoryRetired(
          broker.records,
          scope,
          client ? broker.deadBackend?.(client, transport) : undefined,
        );
      },
      awaitReady: async (
        client: Parameters<
          Awaited<ReturnType<typeof makeV2ApplicationOrchestration>>["preflight"]
        >[0],
        directory: string,
        signal: AbortSignal | undefined,
        hidden: boolean,
        identity?: V2SessionRegistrationIdentity,
      ) => {
        const broker = await acquire();
        if (!identity)
          throw new Error("V2 session registration identity required before activation.");
        const artifact = await selectV2SessionArtifact(broker.artifact, broker.records, identity);
        if (hidden) return activation.passiveReady(descriptor, directory, artifact);
        return activation.awaitReady(artifact, descriptor, client, directory, signal);
      },
    },
    preflight: async (
      client: Parameters<
        Awaited<ReturnType<typeof makeV2ApplicationOrchestration>>["preflight"]
      >[0],
      directory: string,
      signal?: AbortSignal,
    ) => (await acquire()).preflight(client, directory, signal),
    async close() {
      closed = true;
      await initialized?.then((value) => value.close()).catch(() => {});
    },
  };
}
