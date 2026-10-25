import type { OpencodeV2Runtime } from "./Runtime.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import type { V2RuntimeHttpFixture } from "./Runtime.fixture.ts";
import type { V2ConsentAuthority } from "./Application.consent.ts";

/** Independent local detach owners over one synthetic native history; no daemon lifecycle. */
export function sharedV2FixtureOptions(
  runtime: OpencodeV2Runtime,
  http: Pick<V2RuntimeHttpFixture, "client">,
  consent?: V2ConsentAuthority,
) {
  const manager = new OpencodeV2ServerManager({
    maxProcesses: 1,
    maxOwners: 25,
    maxQueuedEvents: 128,
    maxEventBytes: 100000,
    consumerTimeoutMs: 10000,
    ...(consent ? { consent } : {}),
    start: async () => {
      let attached = true;
      return {
        ownership: "borrowed",
        client: http.client,
        isRunning: () => attached,
        hasExited: () => false,
        onDeath: () => () => {},
        close: async () => {
          attached = false;
        },
      };
    },
  });
  return {
    ...runtime.options,
    manager,
    ...(consent ? { consent } : {}),
    config: {
      runtimeTargetId: "local",
      sharedService: {
        registrationFile: "/registered/service.json",
        storageIdentity: "logical-shared-seed",
        generation: "native-generation",
      },
    },
  };
}
