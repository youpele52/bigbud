import { homedir } from "node:os";
import * as fs from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServiceMap from "effect/ServiceMap";
import { ServerConfig } from "../startup/config.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import {
  readMobileNativeInputs,
  type MobileNativeInputsReport,
} from "./mobileGatewayActivation.inputs.read.ts";

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

/** Why inputs are (not) present, for owner status only. Same single read as the inputs. */
export class RemoteMobileNativeInputsReport extends ServiceMap.Service<
  RemoteMobileNativeInputsReport,
  MobileNativeInputsReport
>()("bigbud/remote-backend/MobileNativeInputsReport") {}

/** Owner-status projection of the single inputs read: kind and fixed reason, never contents. */
export const mobileNativeInputsSummary = (report: MobileNativeInputsReport) =>
  Object.freeze({
    state: report.kind,
    reason: report.kind === "invalid" ? report.reason : null,
  });

const reportLayer = (report: MobileNativeInputsReport) =>
  Layer.mergeAll(
    Layer.succeed(
      RemoteMobileNativeInputs,
      report.kind === "loaded" ? Option.some(report.value) : Option.none(),
    ),
    Layer.succeed(RemoteMobileNativeInputsReport, report),
  );

/**
 * Reads the owner-private inputs file once at startup (decision D-A). Off Linux, outside remote
 * mode, or without a backend identity it performs no IO. Missing or invalid inputs mean off:
 * `Option.none()` and no activation controller. A changed file takes effect on restart.
 */
export function makeRemoteMobileNativeInputsLayer(
  options: { readonly platform?: NodeJS.Platform; readonly homeDir?: () => string } = {},
) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* Effect.serviceOption(ServerConfig);
      const identity = yield* Effect.serviceOption(RemoteBackendIdentityService);
      if (
        (options.platform ?? process.platform) !== "linux" ||
        Option.isNone(config) ||
        config.value.mode !== "remote" ||
        Option.isNone(identity)
      )
        return reportLayer({ kind: "unsupported" });
      const authorityId = identity.value.authority.authorityId;
      const report = yield* Effect.promise(async () =>
        readMobileNativeInputs({
          homeDir: await fs.realpath((options.homeDir ?? homedir)()),
          authorityId,
        }).catch((): MobileNativeInputsReport => ({ kind: "invalid", reason: "unsafe-directory" })),
      );
      if (report.kind === "invalid")
        yield* Effect.logWarning("Mobile proof inputs refused; mobile stays off.", {
          reason: report.reason,
        });
      return reportLayer(report);
    }),
  );
}

export const RemoteMobileNativeInputsLive = makeRemoteMobileNativeInputsLayer();
