import * as Layer from "effect/Layer";
import { makeRemoteRuntimeUpdate } from "../runtimeUpdate.operation.ts";
import {
  RemoteRuntimeUpdate,
  type RemoteRuntimeUpdateDependencies,
} from "../Services/RemoteRuntimeUpdate.ts";

/**
 * Remote-backend composition of the runtime update operation. Requires
 * `RemoteRuntimeUpdateOperations`; the integrator (WP-4D) supplies the archive store root,
 * graph source, affected-work inspector and activation seam.
 */
export const makeRemoteRuntimeUpdateLive = (deps: RemoteRuntimeUpdateDependencies) =>
  Layer.effect(RemoteRuntimeUpdate, makeRemoteRuntimeUpdate(deps));
