import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MobileActivationRequestId } from "../remote-agent/mobileGatewayActivation.selection.schema.ts";
import {
  MobileGatewayConfiguration,
  validateMobileGatewayConfiguration,
} from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import type { RemoteMobileNativeInputsValue } from "./mobileGatewayActivation.inputs.ts";
import {
  runNativeMobileActivation,
  type NativeMobileActivationOutcome,
  type NativeMobileActivationRequest,
  type NativeMobileActivationServices,
} from "./mobileGatewayActivation.launch.ts";
import type {
  MobileActivationAcknowledgement,
  MobileActivationController,
  MobileActivationOutcomeSummary,
  MobileRuntimeRepairSummary,
} from "./mobileGatewayActivation.state.ts";
import type { MobileRuntimeRepairReport } from "./mobileGatewayAssets.orphan.ts";
import {
  runMobileRuntimeAssetsRepair,
  type MobileRuntimeAssetsRepairServices,
} from "./mobileGatewayAssets.orphan.repair.ts";
import type { NativeMobileGatewaySessionSignals } from "./mobileGatewayNative.session.ts";
import type { NativeMobileSuccessorOutcome } from "./mobileGatewayNative.successor.ts";
import {
  runNativeMobileSuccessor,
  type NativeMobileSuccessorServices,
} from "./mobileGatewayNative.successorSession.ts";

const ActivationInput = Schema.Struct({
  requestId: MobileActivationRequestId,
  configuration: MobileGatewayConfiguration,
});
export type MobileActivationLaunch = (
  request: NativeMobileActivationRequest,
  signals: NativeMobileGatewaySessionSignals,
  onSelected: () => void,
) => Promise<NativeMobileActivationOutcome>;

/** Successor recovery seam: `onAdopted` fires once a foreign original's intent is restored. */
export type MobileActivationRecover = (
  signals: NativeMobileGatewaySessionSignals,
  onAdopted: () => void,
) => Promise<NativeMobileSuccessorOutcome>;

interface Running {
  readonly kind: "running";
  /** `null` while adopting a predecessor's original through successor recovery. */
  readonly request: NativeMobileActivationRequest | null;
  readonly detach: AbortController;
  readonly stop: AbortController;
  readonly acknowledged: Promise<MobileActivationAcknowledgement>;
  readonly done: Promise<NativeMobileSuccessorOutcome>;
}
/** `uncertain`: a child may still run (detached) or ownership needs repair; never relaunch. */
type Phase =
  | { readonly kind: "idle" }
  | Running
  | { readonly kind: "uncertain"; readonly reason: "detached" | "repair" };

const ack = (
  requestId: string | null,
  status: MobileActivationAcknowledgement["status"],
): MobileActivationAcknowledgement => ({ requestId, status });
/** Native ownership is settled: nothing launched/adopted, or the original exit was recorded. */
const settledOwnership = (outcome: NativeMobileSuccessorOutcome) =>
  outcome.kind === "none" ||
  outcome.kind === "exit-recorded" ||
  outcome.kind === "unavailable" ||
  outcome.kind === "disabled" ||
  (outcome.kind === "failed" && !outcome.repairRequired);
const uncertainty = (outcome: NativeMobileSuccessorOutcome) =>
  outcome.kind === "failed" ? outcome.cause : Error(`Native mobile gateway ${outcome.kind}.`);
const unrecoverable: MobileActivationRecover = async () => ({ kind: "unavailable" });
/** Orphan runtime-asset GC seam; it never touches a native child, lease, pin or publication. */
export type MobileActivationRepair = (signal: AbortSignal) => Promise<MobileRuntimeRepairReport>;
const unrepairable: MobileActivationRepair = () =>
  Promise.reject(Error("Mobile runtime-asset repair is unavailable."));

function decodeActivation(input: unknown): NativeMobileActivationRequest {
  const decoded = Schema.decodeUnknownSync(ActivationInput)(input, { onExcessProperty: "error" });
  validateMobileGatewayConfiguration(decoded.configuration);
  return Object.freeze({
    requestId: decoded.requestId,
    configuration: Object.freeze({ ...decoded.configuration }),
  });
}

/**
 * One native ownership at a time: a fresh activation or a successor adoption. Outcomes map
 * honestly: a recorded exit (or work that never reached Start/adoption) settles; a detach or a
 * repair-required failure leaves the controller `uncertain`, which refuses relaunch and fails
 * `stop` until a later successful `resume` or repair. Work that never selected/adopted anything
 * restores the prior phase, so a `resume` with nothing foreign never clears uncertainty. The
 * controller itself never removes intent or pins; runtime assets are removed only by `repair`,
 * whose journal proof is independent of the controller phase. Repair runs are single-flight.
 */
export function createMobileActivationController(
  launch: MobileActivationLaunch,
  platform: NodeJS.Platform = process.platform,
  recover: MobileActivationRecover = unrecoverable,
  repairAssets: MobileActivationRepair = unrepairable,
): MobileActivationController {
  let phase: Phase = { kind: "idle" };
  let lastOutcome: MobileActivationOutcomeSummary | null = null;
  let lastRepair: MobileRuntimeRepairSummary | null = null;
  let repairing: Promise<MobileRuntimeRepairReport> | undefined;
  const retired = new AbortController();

  const begin = (
    request: NativeMobileActivationRequest | null,
    work: (
      signals: NativeMobileGatewaySessionSignals,
      onSelected: () => void,
    ) => Promise<NativeMobileSuccessorOutcome>,
  ): Running => {
    const previous = phase;
    const requestId = request?.requestId ?? null;
    const detach = new AbortController();
    const stop = new AbortController();
    let selected = false;
    let onSelected!: () => void;
    const selection = new Promise<void>((resolve) => {
      onSelected = () => {
        selected = true;
        resolve();
      };
    });
    const done = Promise.resolve()
      .then(() => work({ detach: detach.signal, stop: stop.signal }, onSelected))
      .catch(
        (cause: unknown): NativeMobileSuccessorOutcome => ({
          kind: "failed",
          repairRequired: selected,
          cause,
        }),
      );
    const acknowledged = Promise.race([
      selection.then(() => ack(requestId, "accepted")),
      done.then((outcome) => {
        if (selected) return ack(requestId, "accepted");
        // Nothing foreign remains to adopt: the predecessor's work is retired.
        if (outcome.kind === "none") return ack(null, "retired");
        if (outcome.kind === "unavailable" || outcome.kind === "disabled")
          return ack(null, outcome.kind);
        throw uncertainty(outcome);
      }),
    ]);
    const running: Running = { kind: "running", request, detach, stop, acknowledged, done };
    void done.then((outcome) => {
      lastOutcome = Object.freeze({
        kind: outcome.kind,
        repairRequired: outcome.kind === "failed" && outcome.repairRequired,
        at: new Date().toISOString(),
      });
      if (phase !== running) return;
      phase = !settledOwnership(outcome)
        ? { kind: "uncertain", reason: outcome.kind === "detached" ? "detached" : "repair" }
        : selected
          ? { kind: "idle" }
          : previous;
    });
    return running;
  };

  return Object.freeze({
    activate: async (input: unknown) => {
      if (platform !== "linux") return ack(null, "unavailable");
      const request = decodeActivation(input);
      if (phase.kind === "uncertain") return ack(null, "unavailable");
      if (phase.kind === "running") {
        const current = phase.request;
        if (
          current &&
          current.requestId === request.requestId &&
          current.configuration.externalOrigin === request.configuration.externalOrigin &&
          current.configuration.port === request.configuration.port
        )
          return phase.acknowledged;
        throw Error("Another mobile gateway activation owns the native lease.");
      }
      const running = begin(request, (signals, onSelected) => launch(request, signals, onSelected));
      phase = running;
      return running.acknowledged;
    },
    // Adopts at most one foreign original; allowed from idle or uncertain, joined while resuming.
    resume: async () => {
      if (platform !== "linux") return ack(null, "unavailable");
      if (phase.kind === "running")
        return phase.request ? ack(null, "unavailable") : phase.acknowledged;
      const running = begin(null, recover);
      phase = running;
      return running.acknowledged;
    },
    stop: async () => {
      if (phase.kind === "idle") return;
      if (phase.kind === "uncertain")
        throw Error("Original native mobile gateway exit cannot be confirmed by this controller.");
      phase.stop.abort(Error("Mobile gateway stop requested."));
      const outcome = await phase.done;
      if (!settledOwnership(outcome)) throw uncertainty(outcome);
    },
    repair: () => {
      if (platform !== "linux")
        return Promise.reject(Error("Mobile runtime-asset repair is unavailable."));
      if (repairing) return repairing;
      const run = Promise.resolve()
        .then(() => repairAssets(retired.signal))
        .then(
          (report) => {
            lastRepair = Object.freeze({
              at: new Date().toISOString(),
              removed: report.removed,
              kept: report.kept,
              failed: false,
            });
            return report;
          },
          (cause: unknown) => {
            lastRepair = Object.freeze({
              at: new Date().toISOString(),
              removed: 0,
              kept: 0,
              failed: true,
            });
            throw cause;
          },
        )
        .finally(() => {
          if (repairing === run) repairing = undefined;
        });
      repairing = run;
      return run;
    },
    close: async () => {
      retired.abort(Error("Mobile activation controller is retiring."));
      await repairing?.catch(() => undefined);
      if (phase.kind !== "running") return;
      phase.detach.abort(Error("Mobile activation controller is retiring."));
      const outcome = await phase.done;
      // A detach hands the child to a successor; only repair-required work is uncertain here.
      if (outcome.kind === "failed" && outcome.repairRequired) throw outcome.cause;
    },
    status: () => ({
      phase: phase.kind === "uncertain" ? (`uncertain-${phase.reason}` as const) : phase.kind,
      lastOutcome,
      lastRepair,
    }),
  });
}

/** Binds the controller to the real activation pipeline under the app's captured services. */
export const makeNativeMobileActivationController = Effect.fn(
  "makeNativeMobileActivationController",
)(function* (inputs: RemoteMobileNativeInputsValue) {
  const run = Effect.runPromiseWith(
    yield* Effect.services<
      | NativeMobileActivationServices
      | NativeMobileSuccessorServices
      | MobileRuntimeAssetsRepairServices
    >(),
  );
  return createMobileActivationController(
    (request, signals, onSelected) =>
      run(runNativeMobileActivation(inputs, request, signals, onSelected)),
    process.platform,
    (signals, onAdopted) => run(runNativeMobileSuccessor(inputs, signals, onAdopted)),
    (signal) => run(runMobileRuntimeAssetsRepair(signal)),
  );
});
