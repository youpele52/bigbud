import { ServiceMap } from "effect";
import type { RemoteAgentOwnerStore } from "../../remote-agent/remoteAgentOwners.ts";

/** One durable CAS/input owner store for all Rust transports using this backend's SqlClient. */
export class RemoteAgentRuntimeOwners extends ServiceMap.Service<
  RemoteAgentRuntimeOwners,
  RemoteAgentOwnerStore
>()("bigbud/persistence/RemoteAgentRuntimeOwners") {}
