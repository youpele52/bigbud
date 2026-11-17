import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServiceMap from "effect/ServiceMap";

/** One signed mobile component pair plus the owner-local paths of its exact bytes. */
export interface RemoteMobileNativeArtifacts {
  readonly stageId: string;
  /** Signed descriptors; the publisher verifies signatures, digests and sizes. */
  readonly gateway: unknown;
  readonly assets: unknown;
  readonly gatewayPath: string;
  readonly assetsPath: string;
}
/** Owner-supplied proof inputs (decision D-A). Never request, settings or download authority. */
export interface RemoteMobileNativeInputsValue {
  readonly trustedKeys: Readonly<Record<string, string>>;
  readonly artifacts: RemoteMobileNativeArtifacts;
}
export class RemoteMobileNativeInputs extends ServiceMap.Service<
  RemoteMobileNativeInputs,
  Option.Option<RemoteMobileNativeInputsValue>
>()("bigbud/remote-backend/MobileNativeInputs") {}

/**
 * Default-off: no production proof inputs exist until the owner-private inputs file lands
 * (increment 6). Absent inputs mean no activation controller is attached and no IO happens.
 */
export const RemoteMobileNativeInputsLive = Layer.succeed(RemoteMobileNativeInputs, Option.none());
