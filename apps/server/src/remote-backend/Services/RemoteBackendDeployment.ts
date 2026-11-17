import * as ServiceMap from "effect/ServiceMap";
import type { RemoteBackendDeployment as RemoteBackendDeploymentShape } from "../deployment.ts";

/** Laptop-driven deployment of a remote backend graph and its persisted relay profile. */
export class RemoteBackendDeployment extends ServiceMap.Service<
  RemoteBackendDeployment,
  Pick<RemoteBackendDeploymentShape, "setupRemoteBackend">
>()("bigbud/remote-backend/RemoteBackendDeployment") {}
